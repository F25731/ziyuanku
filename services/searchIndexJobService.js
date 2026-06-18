const { pool } = require('../config/db');
const searchIndex = require('./searchIndexService');

const DEFAULT_BATCH = Math.max(50, Number(process.env.SEARCH_REINDEX_BATCH || 1000));
const DEFAULT_ATTEMPTS = Math.max(1, Number(process.env.MANTICORE_RETRY_ATTEMPTS || 5));
const OUTBOX_MAX_ATTEMPTS = Math.max(1, Number(process.env.SEARCH_OUTBOX_MAX_ATTEMPTS || 10));

const running = new Map();

function currentEngine() {
  const config = typeof searchIndex.getConfig === 'function' ? searchIndex.getConfig() : null;
  return (config && config.engine) || String(process.env.SEARCH_ENGINE || 'mysql').toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    ...row,
    is_running: row.status === 'running' || running.has(Number(row.id)),
    progress_pct: row.total_resources > 0
      ? Math.min(100, Math.round((Number(row.total_seen || 0) / Number(row.total_resources || 1)) * 100))
      : 0
  };
}

async function countResources({ sourceId = null, startId = 0 }) {
  const where = ['is_deleted = 0', 'id > ?'];
  const params = [Number(startId) || 0];
  if (sourceId) {
    where.push('source_id = ?');
    params.push(Number(sourceId));
  }
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total FROM resources WHERE ${where.join(' AND ')}`,
    params
  );
  return Number(row && row.total || 0);
}

async function getIncrementalStartId(sourceId = null) {
  const engine = currentEngine();
  if (sourceId) {
    const [[scoped]] = await pool.query(
      "SELECT MAX(last_id) AS last_id FROM search_index_jobs WHERE status='completed' AND engine = ? AND source_id = ?",
      [engine, Number(sourceId)]
    );
    if (Number(scoped && scoped.last_id || 0) > 0) return Number(scoped.last_id);
  }
  const [[row]] = await pool.query(
    "SELECT MAX(last_id) AS last_id FROM search_index_jobs WHERE status='completed' AND engine = ? AND source_id IS NULL",
    [engine]
  );
  return Number(row && row.last_id || 0);
}

async function getActiveJob() {
  const [rows] = await pool.query(
    "SELECT * FROM search_index_jobs WHERE status IN ('queued','running') AND engine = ? ORDER BY id DESC LIMIT 1",
    [currentEngine()]
  );
  return normalizeJob(rows[0]);
}

async function getJob(id) {
  const [rows] = await pool.query('SELECT * FROM search_index_jobs WHERE id = ? LIMIT 1', [Number(id)]);
  return normalizeJob(rows[0]);
}

async function listJobs(limit = 20) {
  const [rows] = await pool.query(
    'SELECT * FROM search_index_jobs ORDER BY id DESC LIMIT ?',
    [Math.min(100, Math.max(1, Number(limit) || 20))]
  );
  return rows.map(normalizeJob);
}

async function createJob({ mode = 'full', sourceId = null, batchSize = DEFAULT_BATCH, maxAttempts = DEFAULT_ATTEMPTS } = {}) {
  if (!searchIndex.isEnabled()) {
    throw new Error('Manticore is not enabled; set SEARCH_ENGINE=manticore and MANTICORE_URL first');
  }
  const active = await getActiveJob();
  if (active) {
    if (!running.has(Number(active.id))) runJob(active.id).catch((err) => console.error('[searchJob] takeover failed:', err.message));
    return { already_running: true, job: active };
  }

  mode = mode === 'incremental' ? 'incremental' : 'full';
  sourceId = sourceId ? Number(sourceId) : null;
  const startId = mode === 'incremental' ? await getIncrementalStartId(sourceId) : 0;
  const totalResources = await countResources({ sourceId, startId });
  const bs = Math.min(5000, Math.max(50, Number(batchSize) || DEFAULT_BATCH));
  const attempts = Math.min(20, Math.max(1, Number(maxAttempts) || DEFAULT_ATTEMPTS));

  const [r] = await pool.query(
    `INSERT INTO search_index_jobs
       (mode, engine, status, source_id, batch_size, max_attempts, start_id, last_id, total_resources)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    [mode, currentEngine(), sourceId, bs, attempts, startId, startId, totalResources]
  );
  const id = r.insertId;
  runJob(id).catch((err) => console.error('[searchJob] failed:', err.message));
  return { already_running: false, job: await getJob(id) };
}

async function resumeJob(id) {
  const job = await getJob(id);
  if (!job) throw new Error('job not found');
  if (job.status === 'completed') throw new Error('completed job cannot be resumed');
  const active = await getActiveJob();
  if (active && Number(active.id) !== Number(id)) return { already_running: true, job: active };
  const totalResources = await countResources({ sourceId: job.source_id, startId: job.last_id });
  await pool.query(
    `UPDATE search_index_jobs
        SET engine=?, status='queued', total_resources=?, last_error=NULL, finished_at=NULL
      WHERE id=?`,
    [currentEngine(), Number(job.total_seen || 0) + totalResources, Number(id)]
  );
  runJob(Number(id)).catch((err) => console.error('[searchJob] resume failed:', err.message));
  return { already_running: false, job: await getJob(id) };
}

async function pauseJob(id) {
  const ctx = running.get(Number(id));
  if (ctx) ctx.pause = true;
  await pool.query("UPDATE search_index_jobs SET status='paused', finished_at=NOW() WHERE id=? AND status IN ('queued','running')", [Number(id)]);
  return getJob(id);
}

async function deleteJob(id) {
  const job = await getJob(id);
  if (!job) return { deleted: 0 };
  if (['queued', 'running'].includes(job.status) || running.has(Number(id))) {
    throw new Error('running search index job cannot be deleted; pause it first');
  }
  const [r] = await pool.query(
    "DELETE FROM search_index_jobs WHERE id=? AND status NOT IN ('queued','running')",
    [Number(id)]
  );
  return { deleted: r.affectedRows || 0 };
}

async function clearJobs() {
  const [r] = await pool.query(
    "DELETE FROM search_index_jobs WHERE status NOT IN ('queued','running')"
  );
  return { deleted: r.affectedRows || 0 };
}

async function runJob(id) {
  id = Number(id);
  if (running.has(id)) return;
  const ctx = { pause: false };
  running.set(id, ctx);
  try {
    let job = await getJob(id);
    if (!job || !['queued', 'running'].includes(job.status)) return;
    await pool.query(
      "UPDATE search_index_jobs SET status='running', started_at=COALESCE(started_at, NOW()), finished_at=NULL WHERE id=?",
      [id]
    );
    const ready = await searchIndex.waitUntilReady(90000);
    if (!ready) {
      const err = searchIndex.getLastError() || 'Manticore is not ready';
      await pool.query(
        `UPDATE search_index_jobs
            SET status='failed', last_error=?, finished_at=NOW()
          WHERE id=?`,
        [err.slice(0, 1000), id]
      );
      return;
    }
    job = await getJob(id);
    if (job && job.mode === 'full' && Number(job.start_id || 0) === 0 && Number(job.last_id || 0) === 0 && Number(job.total_seen || 0) === 0) {
      const resetOk = typeof searchIndex.resetIndex === 'function' ? await searchIndex.resetIndex() : true;
      if (!resetOk) {
        const err = searchIndex.getLastError() || 'Manticore index reset failed';
        await pool.query(
          `UPDATE search_index_jobs
              SET status='failed', last_error=?, finished_at=NOW()
            WHERE id=?`,
          [err.slice(0, 1000), id]
        );
        return;
      }
    }

    while (!ctx.pause) {
      job = await getJob(id);
      if (!job || job.status === 'paused') break;

      const where = ['id > ?', 'is_deleted = 0'];
      const params = [Number(job.last_id || 0)];
      if (job.source_id) {
        where.push('source_id = ?');
        params.push(Number(job.source_id));
      }
      params.push(Number(job.batch_size || DEFAULT_BATCH));
      const [rows] = await pool.query(
        `SELECT id, source_id, file_name, file_type, is_deleted
           FROM resources
          WHERE ${where.join(' AND ')}
          ORDER BY id ASC
          LIMIT ?`,
        params
      );

      if (!rows.length) {
        await pool.query(
          "UPDATE search_index_jobs SET status='completed', finished_at=NOW(), last_error=NULL WHERE id=?",
          [id]
        );
        break;
      }

      let ok = false;
      let lastErr = '';
      for (let attempt = 1; attempt <= Number(job.max_attempts || DEFAULT_ATTEMPTS); attempt++) {
        if (!(await searchIndex.waitUntilReady(60000))) {
          lastErr = searchIndex.getLastError() || 'Manticore is not ready';
          await pool.query(
            'UPDATE search_index_jobs SET attempts=attempts+1, last_error=? WHERE id=?',
            [lastErr.slice(0, 1000), id]
          );
          await sleep(Math.min(60000, 10000 + attempt * attempt * 1000));
          continue;
        }
        ok = await searchIndex.bulkIndexRows(rows, { waitTasks: true });
        if (ok) break;
        lastErr = searchIndex.getLastError() || 'bulk index returned false';
        await pool.query(
          'UPDATE search_index_jobs SET attempts=attempts+1, last_error=? WHERE id=?',
          [lastErr.slice(0, 1000), id]
        );
        await sleep(Math.min(60000, 15000 + attempt * attempt * 1000));
      }

      if (!ok) {
        await pool.query(
          `UPDATE search_index_jobs
              SET status='failed', total_failed=total_failed+?, last_error=?, finished_at=NOW()
            WHERE id=?`,
          [rows.length, lastErr.slice(0, 1000), id]
        );
        break;
      }

      const lastId = Number(rows[rows.length - 1].id);
      await pool.query(
        `UPDATE search_index_jobs
            SET last_id=?, total_seen=total_seen+?, total_indexed=total_indexed+?, last_error=NULL
          WHERE id=?`,
        [lastId, rows.length, rows.length, id]
      );
      await sleep(10);
    }

    if (ctx.pause) {
      await pool.query("UPDATE search_index_jobs SET status='paused', finished_at=NOW() WHERE id=? AND status='running'", [id]);
    }
  } finally {
    running.delete(id);
  }
}

async function getOutboxStats() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(op='upsert') AS upserts,
            SUM(op='delete') AS deletes,
            SUM(attempts > 0) AS retrying,
            SUM(attempts >= ?) AS failed
       FROM search_index_outbox`,
    [OUTBOX_MAX_ATTEMPTS]
  );
  return {
    total: Number(row.total || 0),
    upserts: Number(row.upserts || 0),
    deletes: Number(row.deletes || 0),
    retrying: Number(row.retrying || 0),
    failed: Number(row.failed || 0),
    max_attempts: OUTBOX_MAX_ATTEMPTS
  };
}

async function retryFailedOutbox() {
  const [r] = await pool.query(
    `UPDATE search_index_outbox
        SET attempts=0, available_at=NOW(), locked_at=NULL, last_error=NULL
      WHERE attempts >= ?`,
    [OUTBOX_MAX_ATTEMPTS]
  );
  return { changed: r.affectedRows || 0 };
}

async function getStatus() {
  const [[resourceRow]] = await pool.query("SELECT COUNT(*) AS total FROM resources WHERE is_deleted=0");
  const [overview, outbox, jobs] = await Promise.all([
    searchIndex.getOverview(),
    getOutboxStats(),
    listJobs(20)
  ]);
  const activeJob = jobs.find((j) => ['queued', 'running'].includes(j.status) && j.engine === currentEngine()) || null;
  return {
    config: overview.config,
    engine: {
      health: overview.health,
      index: overview.index,
      tasks: overview.tasks,
      task_summary: overview.task_summary
    },
    mysql: { resources: Number(resourceRow.total || 0) },
    outbox,
    active_job: activeJob,
    jobs
  };
}

module.exports = {
  createJob,
  resumeJob,
  pauseJob,
  deleteJob,
  clearJobs,
  getJob,
  listJobs,
  getStatus,
  retryFailedOutbox
};
