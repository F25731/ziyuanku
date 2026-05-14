const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { getSource } = require('./sourceService');
const { upsertResources } = require('./resourceService');
const HttpError = require('../utils/httpError');

// 阶段3 H：每日 list 调用预算（蓝奏官方 web 客户端典型一天的活跃量上限附近）
const DAILY_LIST_QUOTA = Math.max(100, Number(process.env.SYNC_DAILY_LIST_QUOTA || 5000));
const UPSERT_BATCH = Math.max(50, Number(process.env.SYNC_UPSERT_BATCH || 500));

function toSyncHash(item) {
  return crypto.createHash('md5')
    .update([item.file_id || '', item.file_name || '', item.share_url || ''].join('|'))
    .digest('hex');
}

async function createSyncLog(sourceId, status, message) {
  const [r] = await pool.query(
    'INSERT INTO sync_logs (source_id, status, message) VALUES (?, ?, ?)',
    [sourceId, status, message || '']
  );
  return r.insertId;
}

async function finishSyncLog(logId, status, message, total = 0) {
  await pool.query(
    'UPDATE sync_logs SET status=?, message=?, total=?, finished_at=NOW() WHERE id=?',
    [status, message || '', Number(total) || 0, logId]
  );
}

// ===== sync_runs / sync_progress 操作 =====

async function findOpenRun(sourceId) {
  const [rows] = await pool.query(
    "SELECT * FROM sync_runs WHERE source_id=? AND status IN ('running','paused') ORDER BY id DESC LIMIT 1",
    [sourceId]
  );
  return rows[0] || null;
}

async function createRun(sourceId, mode, rootFolderId) {
  const [r] = await pool.query(
    'INSERT INTO sync_runs (source_id, mode, status, root_folder_id, started_at, last_resume_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
    [sourceId, mode, 'running', String(rootFolderId || '0')]
  );
  // 初始进度：根目录 next_offset=1
  await pool.query(
    'INSERT INTO sync_progress (run_id, folder_id, next_offset, total_page, done) VALUES (?, ?, 1, 0, 0)',
    [r.insertId, String(rootFolderId || '0')]
  );
  return r.insertId;
}

async function markRunResumed(runId) {
  await pool.query(
    "UPDATE sync_runs SET status='running', last_resume_at=NOW(), paused_at=NULL WHERE id=?",
    [runId]
  );
}

async function pauseRun(runId, message) {
  await pool.query(
    "UPDATE sync_runs SET status='paused', paused_at=NOW(), last_message=? WHERE id=?",
    [String(message || '').slice(0, 500), runId]
  );
}

async function completeRun(runId, message) {
  await pool.query(
    "UPDATE sync_runs SET status='completed', finished_at=NOW(), last_message=? WHERE id=?",
    [String(message || '').slice(0, 500), runId]
  );
}

async function failRun(runId, message) {
  await pool.query(
    "UPDATE sync_runs SET status='failed', finished_at=NOW(), last_message=? WHERE id=?",
    [String(message || '').slice(0, 500), runId]
  );
}

async function loadResumeState(runId) {
  const [rows] = await pool.query(
    'SELECT folder_id, next_offset, total_page, done FROM sync_progress WHERE run_id=?',
    [runId]
  );
  const resume = {};
  const pending = [];
  for (const r of rows) {
    resume[r.folder_id] = {
      next_offset: Number(r.next_offset) || 1,
      total_page: Number(r.total_page) || 0,
      done: Number(r.done) || 0
    };
    if (!Number(r.done)) pending.push(r.folder_id);
  }
  return { resume, pending };
}

async function upsertProgress(runId, folderId, nextOffset, totalPage, done) {
  await pool.query(
    `INSERT INTO sync_progress (run_id, folder_id, next_offset, total_page, done, last_pulled_at)
       VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       next_offset=VALUES(next_offset),
       total_page=VALUES(total_page),
       done=VALUES(done),
       last_pulled_at=VALUES(last_pulled_at)`,
    [runId, String(folderId), Math.max(1, Number(nextOffset) || 1), Math.max(0, Number(totalPage) || 0), done ? 1 : 0]
  );
}

async function bumpRunCounters(runId, addCalls, addFiles) {
  if (!addCalls && !addFiles) return;
  await pool.query(
    'UPDATE sync_runs SET total_calls=total_calls+?, total_files=total_files+? WHERE id=?',
    [Number(addCalls) || 0, Number(addFiles) || 0, runId]
  );
}

// 今天还剩多少 list 调用预算
async function todaysRemainingQuota(sourceId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(total_calls),0) AS used
       FROM sync_runs
      WHERE source_id=? AND last_resume_at >= CURDATE()`,
    [sourceId]
  );
  const used = Number(row && row.used) || 0;
  return Math.max(0, DAILY_LIST_QUOTA - used);
}

// 流式跑子进程：边收 NDJSON 事件，边写 DB
function streamRunIlanzouScript({ source, mode, syncRunId, dailyCallBudget, resume, pendingFolders, onFile, onProgress, onMessage }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'ilanzou_sync_sdk.js');
    const child = spawn('node', [scriptPath], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stderr = '';
    let endEvent = null;
    let lineErr = null;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return;
      let evt;
      try { evt = JSON.parse(trimmed); } catch (_) { return; }
      try {
        if (evt.event === 'file') {
          await onFile(evt.data);
        } else if (evt.event === 'progress') {
          await onProgress(evt);
        } else if (evt.event === 'message') {
          if (typeof onMessage === 'function') onMessage(evt.text || '');
        } else if (evt.event === 'end') {
          endEvent = evt;
        }
      } catch (err) {
        lineErr = err;
      }
    });

    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (lineErr) return reject(lineErr);
      if (code !== 0 && !endEvent) {
        return reject(new Error(stderr || `同步脚本退出码 ${code}`));
      }
      if (!endEvent) return reject(new Error('同步脚本未输出 end 事件: ' + stderr));
      if (!endEvent.ok) return reject(new Error(endEvent.message || '同步失败'));
      resolve(endEvent);
    });

    child.stdin.write(JSON.stringify({
      provider: source.provider,
      rootFolderId: source.root_folder_id,
      loginType: source.login_type,
      account: source.account,
      password: source.password_text,
      cookie: source.cookie_text,
      mode,
      syncRunId,
      dailyCallBudget,
      resume,
      pendingFolders
    }));
    child.stdin.end();
  });
}

async function syncSource(sourceId, mode = 'incremental') {
  const source = await getSource(sourceId);
  if (!source) throw new HttpError(404, '来源不存在');
  if (source.provider !== 'ilanzou' || source.login_type !== 'account') {
    throw new HttpError(400, '目前仅支持 ilanzou 账号模式同步');
  }

  // full = 重置：把现有 paused/running run 的进度全清掉，重新建一个 run
  if (mode === 'full') {
    await pool.query("UPDATE sync_runs SET status='failed', finished_at=NOW(), last_message='被全量重置覆盖' WHERE source_id=? AND status IN ('running','paused')", [sourceId]);
  }

  let run = mode === 'full' ? null : await findOpenRun(sourceId);
  if (!run) {
    const id = await createRun(sourceId, mode, source.root_folder_id || '0');
    run = (await pool.query('SELECT * FROM sync_runs WHERE id=?', [id]))[0][0];
  } else {
    await markRunResumed(run.id);
  }

  const remaining = await todaysRemainingQuota(sourceId);
  if (remaining <= 0) {
    const msg = `今日 list 调用预算已用完（上限 ${DAILY_LIST_QUOTA}），run #${run.id} 已暂停，明天再继续`;
    await pauseRun(run.id, msg);
    return { run_id: run.id, status: 'paused', remaining_quota: 0, message: msg };
  }

  const { resume, pending } = await loadResumeState(run.id);
  const logId = await createSyncLog(sourceId, 'running',
    `run#${run.id} ${mode} 启动，今日剩余预算=${remaining}，待扫目录=${pending.length}`);

  // 流式入库分批缓冲
  let batch = [];
  let totalFiles = 0;
  let totalCalls = 0;

  const flush = async () => {
    if (!batch.length) return;
    const items = batch.map((f) => ({ ...f, sync_hash: toSyncHash(f) }));
    await upsertResources(sourceId, items);
    totalFiles += items.length;
    batch = [];
  };

  try {
    const endEvt = await streamRunIlanzouScript({
      source,
      mode,
      syncRunId: run.id,
      dailyCallBudget: remaining,
      resume,
      pendingFolders: pending.length ? pending : [String(source.root_folder_id || '0')],
      onFile: async (file) => {
        batch.push(file);
        if (batch.length >= UPSERT_BATCH) await flush();
      },
      onProgress: async (p) => {
        totalCalls++;
        if (run.id) await upsertProgress(run.id, p.folder_id, p.next_offset, p.total_page, p.done);
      }
    });

    await flush();
    await bumpRunCounters(run.id, totalCalls, totalFiles);

    if (endEvt.reason === 'completed') {
      const msg = `run#${run.id} 已完成：累计文件 ${endEvt.total_files || totalFiles}，本次新增 ${totalFiles}，本次 list 调用 ${totalCalls}`;
      await completeRun(run.id, msg);
      await finishSyncLog(logId, 'success', msg, totalFiles);
      return { run_id: run.id, status: 'completed', total: totalFiles, calls: totalCalls };
    }
    // daily_quota_reached / cooldown / etc.
    const msg = `run#${run.id} 暂停（${endEvt.reason}）：本次新增 ${totalFiles}，list 调用 ${totalCalls}，剩余目录 ${(endEvt.remaining_folders || []).length}`;
    await pauseRun(run.id, msg);
    await finishSyncLog(logId, 'success', msg, totalFiles);
    return { run_id: run.id, status: 'paused', reason: endEvt.reason, total: totalFiles, calls: totalCalls };
  } catch (err) {
    try { await flush(); } catch (_) {}
    await bumpRunCounters(run.id, totalCalls, totalFiles);
    // 风控/冷却 → paused 而非 failed，方便明天重启
    const msg = err && err.message || String(err);
    if (/冷却|风控|频繁|限制|429/i.test(msg)) {
      await pauseRun(run.id, '触发风控/冷却：' + msg);
      await finishSyncLog(logId, 'failed', msg, totalFiles);
    } else {
      await failRun(run.id, msg);
      await finishSyncLog(logId, 'failed', msg, totalFiles);
    }
    throw err;
  }
}

async function checkSource(sourceId) {
  const source = await getSource(sourceId);
  if (!source) throw new HttpError(404, '来源不存在');
  const logId = await createSyncLog(sourceId, 'running', '开始检测（仅根目录第一页）');
  try {
    let count = 0;
    await streamRunIlanzouScript({
      source,
      mode: 'check-only',
      syncRunId: 0,
      dailyCallBudget: 1, // 只允许 1 次 list 调用
      resume: {},
      pendingFolders: [String(source.root_folder_id || '0')],
      onFile: async () => { count++; },
      onProgress: async () => {}
    });
    await pool.query('UPDATE sources SET last_check_at=NOW() WHERE id=?', [sourceId]);
    await finishSyncLog(logId, 'success', `检测成功（首页 ${count} 个文件，未写库）`, count);
    return { total: count };
  } catch (err) {
    await finishSyncLog(logId, 'failed', err.message || String(err));
    throw err;
  }
}

async function listSyncLogs(limit = 100) {
  const [rows] = await pool.query(
    'SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?',
    [Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

async function clearSyncLogs() {
  await pool.query('DELETE FROM sync_logs');
}

async function listSyncRuns(sourceId, limit = 30) {
  const params = [];
  let where = '';
  if (sourceId) { where = 'WHERE source_id=?'; params.push(sourceId); }
  params.push(Math.min(Number(limit) || 30, 200));
  const [rows] = await pool.query(
    `SELECT * FROM sync_runs ${where} ORDER BY id DESC LIMIT ?`,
    params
  );
  return rows;
}

module.exports = { syncSource, checkSource, listSyncLogs, clearSyncLogs, listSyncRuns, DAILY_LIST_QUOTA };
