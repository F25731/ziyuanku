const { pool } = require('../config/db');
const searchIndex = require('./searchIndexService');

const BATCH = Math.max(10, Number(process.env.SEARCH_OUTBOX_BATCH || 500));
const INTERVAL_MS = Math.max(1000, Number(process.env.SEARCH_OUTBOX_INTERVAL_MS || 5000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SEARCH_OUTBOX_MAX_ATTEMPTS || 10));

let timer = null;
let running = false;
let stopped = false;

async function enqueueUpsertsBySourceFileIds(sourceId, fileIds) {
  if (!searchIndex.isEnabled() || !Array.isArray(fileIds) || !fileIds.length) return 0;
  const ids = Array.from(new Set(fileIds.map((x) => String(x || '').trim()).filter(Boolean)));
  if (!ids.length) return 0;
  const [rows] = await pool.query(
    'SELECT id FROM resources WHERE source_id = ? AND file_id IN (?)',
    [sourceId, ids]
  );
  return enqueueUpserts(rows.map((r) => r.id));
}

async function enqueueUpserts(resourceIds) {
  if (!searchIndex.isEnabled() || !Array.isArray(resourceIds) || !resourceIds.length) return 0;
  const ids = Array.from(new Set(resourceIds.map(Number).filter(Boolean)));
  if (!ids.length) return 0;
  await pool.query(
    `INSERT INTO search_index_outbox (resource_id, op, attempts, available_at, locked_at, last_error)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       op='upsert',
       attempts=0,
       available_at=NOW(),
       locked_at=NULL,
       last_error=NULL`,
    [ids.map((id) => [id, 'upsert', 0, new Date(), null, null])]
  );
  return ids.length;
}

async function enqueueDelete(resourceId) {
  const id = Number(resourceId);
  if (!searchIndex.isEnabled() || !id) return 0;
  return enqueueDeletes([id]);
}

async function enqueueDeletes(resourceIds) {
  if (!searchIndex.isEnabled() || !Array.isArray(resourceIds) || !resourceIds.length) return 0;
  const ids = Array.from(new Set(resourceIds.map(Number).filter(Boolean)));
  if (!ids.length) return 0;
  await pool.query(
    `INSERT INTO search_index_outbox (resource_id, op, attempts, available_at, locked_at, last_error)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       op='delete',
       attempts=0,
       available_at=NOW(),
       locked_at=NULL,
       last_error=NULL`,
    [ids.map((id) => [id, 'delete', 0, new Date(), null, null])]
  );
  return ids.length;
}

async function claimBatch(limit = BATCH) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT resource_id, op, attempts
         FROM search_index_outbox
        WHERE available_at <= NOW() AND attempts < ?
        ORDER BY updated_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, Math.max(1, Number(limit) || BATCH)]
    );
    if (rows.length) {
      await conn.query(
        `UPDATE search_index_outbox
            SET locked_at=NOW()
          WHERE resource_id IN (?)`,
        [rows.map((r) => r.resource_id)]
      );
    }
    await conn.commit();
    return rows;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function markDone(ids) {
  if (!ids.length) return;
  await pool.query('DELETE FROM search_index_outbox WHERE resource_id IN (?)', [ids]);
}

async function markFailed(ids, err) {
  if (!ids.length) return;
  const msg = String(err && err.message || err || 'index failed').slice(0, 1000);
  await pool.query(
    `UPDATE search_index_outbox
        SET attempts=attempts+1,
            locked_at=NULL,
            last_error=?,
            available_at=DATE_ADD(NOW(), INTERVAL LEAST(3600, POW(2, attempts + 1)) SECOND)
      WHERE resource_id IN (?)`,
    [msg, ids]
  );
}

async function processBatch(limit = BATCH) {
  if (!searchIndex.isEnabled()) return { processed: 0, failed: 0 };
  const rows = await claimBatch(limit);
  if (!rows.length) return { processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;
  const deletes = rows.filter((r) => r.op === 'delete').map((r) => Number(r.resource_id));
  const upserts = rows.filter((r) => r.op === 'upsert').map((r) => Number(r.resource_id));

  if (upserts.length) {
    try {
      const [resourceRows] = await pool.query(
        `SELECT id, source_id, file_id, file_name, file_size, file_size_bytes, file_type, file_ext,
                file_time, share_url, is_deleted, created_at, updated_at
           FROM resources
          WHERE id IN (?)`,
        [upserts]
      );
      const existingIds = new Set(resourceRows.map((r) => Number(r.id)));
      const missing = upserts.filter((id) => !existingIds.has(id));
      let ok = true;
      if (resourceRows.length) ok = await searchIndex.bulkIndexRows(resourceRows);
      if (!ok) {
        await markFailed(upserts, 'bulk index returned false');
        failed += upserts.length;
      } else {
        for (const id of missing) {
          await searchIndex.deleteResource(id);
        }
        await markDone(upserts);
        processed += upserts.length;
      }
    } catch (err) {
      await markFailed(upserts, err);
      failed += upserts.length;
    }
  }

  for (const id of deletes) {
    try {
      await searchIndex.deleteResource(id);
      await markDone([id]);
      processed++;
    } catch (err) {
      await markFailed([id], err);
      failed++;
    }
  }

  return { processed, failed };
}

function startWorker() {
  if (timer || stopped) return;
  if (String(process.env.SEARCH_OUTBOX_WORKER_ENABLED || '1') === '0') return;
  if (!searchIndex.isEnabled()) return;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const r = await processBatch(BATCH);
      if (r.processed || r.failed) {
        console.log(`[searchOutbox] processed=${r.processed} failed=${r.failed}`);
      }
    } catch (err) {
      console.warn('[searchOutbox] worker failed:', err.message);
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, INTERVAL_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
  };
  timer = setTimeout(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopWorker() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  enqueueUpsertsBySourceFileIds,
  enqueueUpserts,
  enqueueDelete,
  enqueueDeletes,
  processBatch,
  startWorker,
  stopWorker
};
