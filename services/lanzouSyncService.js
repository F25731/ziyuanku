const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const EventEmitter = require('events');
const { pool } = require('../config/db');
const { getSource } = require('./sourceService');
const { upsertResources } = require('./resourceService');
const ilanzouApi = require('./ilanzouApi');
const HttpError = require('../utils/httpError');

// 阶段4：抛弃每日预算闸门，对齐 OpenList 风格——一次跑到底，
// 真触发风控才退避。保留断点续扫（崩溃/网络抖动总会有）。
const UPSERT_BATCH = Math.max(50, Number(process.env.SYNC_UPSERT_BATCH || 500));
const DEFAULT_MAX_DEPTH = Math.max(1, Number(process.env.SYNC_MAX_INDEX_DEPTH || 20));
const EVENT_BACKLOG = 1000;

function toSyncHash(item) {
  return crypto.createHash('md5')
    .update([item.file_id || '', item.file_name || '', item.share_url || ''].join('|'))
    .digest('hex');
}

// ===== 全局事件总线：runId -> { emitter, ring(最近 N 条事件)} =====
const runBuses = new Map();

function getRunBus(runId) {
  let bus = runBuses.get(runId);
  if (!bus) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    bus = { emitter, ring: [], closed: false };
    runBuses.set(runId, bus);
  }
  return bus;
}

function publishRunEvent(runId, evt) {
  if (!runId) return;
  const bus = getRunBus(runId);
  bus.ring.push(evt);
  if (bus.ring.length > EVENT_BACKLOG) bus.ring.splice(0, bus.ring.length - EVENT_BACKLOG);
  bus.emitter.emit('event', evt);
}

function closeRunBus(runId, finalEvt) {
  const bus = runBuses.get(runId);
  if (!bus) return;
  if (finalEvt) {
    bus.ring.push(finalEvt);
    bus.emitter.emit('event', finalEvt);
  }
  bus.closed = true;
  bus.emitter.emit('close');
  setTimeout(() => runBuses.delete(runId), 60_000); // 1 分钟后回收
}

function subscribeRun(runId, sinceEventId = 0) {
  const bus = getRunBus(runId);
  return {
    backlog: bus.ring.filter((e) => Number(e.event_id || 0) > Number(sinceEventId || 0)),
    emitter: bus.emitter,
    closed: bus.closed
  };
}

// ===== sync_run_events: 持久化事件，方便回看 =====
async function recordEvent(runId, level, event, message, payload) {
  if (!runId) return null;
  try {
    const [r] = await pool.query(
      'INSERT INTO sync_run_events (run_id, level, event, message, payload) VALUES (?, ?, ?, ?, ?)',
      [runId, level || 'info', String(event).slice(0, 40), String(message || '').slice(0, 1000),
       payload ? JSON.stringify(payload).slice(0, 8000) : null]
    );
    const evt = {
      event_id: r.insertId,
      run_id: runId,
      level: level || 'info',
      event,
      message: message || '',
      payload: payload || null,
      created_at: new Date().toISOString()
    };
    publishRunEvent(runId, evt);
    return evt;
  } catch (err) {
    console.error('[lanzouSyncService] recordEvent failed', err.message);
    return null;
  }
}

async function listRunEvents(runId, sinceId = 0, limit = 500) {
  const [rows] = await pool.query(
    'SELECT id AS event_id, run_id, level, event, message, payload, created_at FROM sync_run_events WHERE run_id=? AND id>? ORDER BY id ASC LIMIT ?',
    [runId, Number(sinceId) || 0, Math.min(Number(limit) || 500, 2000)]
  );
  return rows.map((r) => ({ ...r, payload: r.payload ? safeJson(r.payload) : null }));
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

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

async function createRun(sourceId, mode, rootFolderId, maxDepth) {
  const [r] = await pool.query(
    'INSERT INTO sync_runs (source_id, mode, status, root_folder_id, max_index_depth, started_at, last_resume_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
    [sourceId, mode, 'running', String(rootFolderId || '0'), Number(maxDepth) || DEFAULT_MAX_DEPTH]
  );
  await pool.query(
    'INSERT INTO sync_progress (run_id, folder_id, next_offset, total_page, done) VALUES (?, ?, 1, 0, 0)',
    [r.insertId, String(rootFolderId || '0')]
  );
  return r.insertId;
}

async function getRun(runId) {
  const [rows] = await pool.query('SELECT * FROM sync_runs WHERE id=?', [runId]);
  return rows[0] || null;
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

// ===== 删除源时级联清理 =====
async function deleteRunsBySource(sourceId) {
  // 先读所有 run_id，再级联清进度/事件
  const [runs] = await pool.query('SELECT id FROM sync_runs WHERE source_id=?', [sourceId]);
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM sync_progress WHERE run_id IN (?)', [ids]);
    await pool.query('DELETE FROM sync_run_events WHERE run_id IN (?)', [ids]);
  }
  await pool.query('DELETE FROM sync_runs WHERE source_id=?', [sourceId]);
}

// ===== 流式跑子进程：边收 NDJSON 事件，边广播，边写库 =====
function streamRunIlanzouScript({ source, mode, syncRunId, maxIndexDepth, resume, pendingFolders, depthMap, onFile, onPage, onMessage }) {
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
        } else if (evt.event === 'page') {
          await onPage(evt);
        } else if (evt.event === 'message') {
          if (typeof onMessage === 'function') await onMessage(evt);
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
      mode,
      syncRunId,
      maxIndexDepth,
      resume,
      pendingFolders,
      depthMap
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

  if (mode === 'full') {
    await pool.query("UPDATE sync_runs SET status='failed', finished_at=NOW(), last_message='被全量重置覆盖' WHERE source_id=? AND status IN ('running','paused')", [sourceId]);
  }

  let run = mode === 'full' ? null : await findOpenRun(sourceId);
  const maxDepth = Number(source.max_index_depth) > 0 ? Number(source.max_index_depth) : DEFAULT_MAX_DEPTH;
  if (!run) {
    const id = await createRun(sourceId, mode, source.root_folder_id || '0', maxDepth);
    run = await getRun(id);
  } else {
    await markRunResumed(run.id);
  }

  const { resume, pending } = await loadResumeState(run.id);
  const logId = await createSyncLog(sourceId, 'running',
    `run#${run.id} ${mode} 启动，待扫目录=${pending.length}`);

  await recordEvent(run.id, 'info', 'run_started',
    `run#${run.id} ${mode} 启动 (max_depth=${maxDepth})`,
    { mode, max_depth: maxDepth, pending_folders: pending.length });

  // 流式入库分批缓冲
  let batch = [];
  let totalFiles = 0;
  let totalCalls = 0;
  let lastSummaryAt = Date.now();

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
      maxIndexDepth: maxDepth,
      resume,
      pendingFolders: pending.length ? pending : [String(source.root_folder_id || '0')],
      depthMap: { [String(source.root_folder_id || '0')]: 0 },
      onFile: async (file) => {
        batch.push(file);
        if (batch.length >= UPSERT_BATCH) await flush();
      },
      onPage: async (p) => {
        totalCalls++;
        await upsertProgress(run.id, p.folder_id, p.next_offset, p.total_page, p.done);
        // 不每页都写事件库（百万级会爆），改成定速 summary
        if (Date.now() - lastSummaryAt >= 2000) {
          lastSummaryAt = Date.now();
          await recordEvent(run.id, 'info', 'progress',
            `已拉 ${totalCalls} 页 / ${totalFiles + batch.length} 文件入库 / 当前 folder=${p.folder_id} 第 ${p.next_offset - 1}/${p.total_page} 页`,
            { calls: totalCalls, files: totalFiles + batch.length, folder_id: p.folder_id });
        }
        if (p.done) {
          await recordEvent(run.id, 'info', 'folder_done',
            `folder=${p.folder_id} 已扫完 (共 ${p.total_page} 页)`,
            { folder_id: p.folder_id, total_page: p.total_page });
        }
      },
      onMessage: async (m) => {
        await recordEvent(run.id, m.level || 'info', m.event || 'message', m.message || '', m.payload || null);
      }
    });

    await flush();
    await bumpRunCounters(run.id, totalCalls, totalFiles);

    if (endEvt.reason === 'completed') {
      const msg = `run#${run.id} 已完成: 累计文件 ${totalFiles}, list 调用 ${totalCalls}`;
      await completeRun(run.id, msg);
      await finishSyncLog(logId, 'success', msg, totalFiles);
      const finalEvt = await recordEvent(run.id, 'done', 'completed', msg, { total_files: totalFiles, total_calls: totalCalls });
      closeRunBus(run.id, finalEvt);
      return { run_id: run.id, status: 'completed', total: totalFiles, calls: totalCalls };
    }
    const msg = `run#${run.id} 暂停 (${endEvt.reason}): 本次新增 ${totalFiles}, list 调用 ${totalCalls}, 剩余目录 ${(endEvt.remaining_folders || []).length}`;
    await pauseRun(run.id, msg);
    await finishSyncLog(logId, 'success', msg, totalFiles);
    const finalEvt = await recordEvent(run.id, 'warn', 'paused', msg,
      { reason: endEvt.reason, total_files: totalFiles, total_calls: totalCalls, remaining: (endEvt.remaining_folders || []).length });
    closeRunBus(run.id, finalEvt);
    return { run_id: run.id, status: 'paused', reason: endEvt.reason, total: totalFiles, calls: totalCalls };
  } catch (err) {
    try { await flush(); } catch (_) {}
    await bumpRunCounters(run.id, totalCalls, totalFiles);
    const msg = err && err.message || String(err);
    if (/冷却|风控|频繁|限制|429/i.test(msg)) {
      await pauseRun(run.id, '触发风控/冷却: ' + msg);
      await finishSyncLog(logId, 'failed', msg, totalFiles);
      const finalEvt = await recordEvent(run.id, 'warn', 'rate_limited', msg, null);
      closeRunBus(run.id, finalEvt);
    } else {
      await failRun(run.id, msg);
      await finishSyncLog(logId, 'failed', msg, totalFiles);
      const finalEvt = await recordEvent(run.id, 'error', 'failed', msg, null);
      closeRunBus(run.id, finalEvt);
    }
    throw err;
  }
}

// 测试连接：login + 拿 userId，半秒级，不拉 list、不入库
async function testConnection(sourceId) {
  const source = await getSource(sourceId);
  if (!source) throw new HttpError(404, '来源不存在');
  if (source.provider !== 'ilanzou' || source.login_type !== 'account') {
    throw new HttpError(400, '目前仅支持 ilanzou 账号模式');
  }
  ilanzouApi.invalidateClient(source.account);
  const ctx = await ilanzouApi.getClient(source.account, source.password_text);
  await pool.query('UPDATE sources SET last_check_at=NOW() WHERE id=?', [sourceId]);
  return { account: source.account, user_id: ctx.userId, message: '账号登录成功' };
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

module.exports = {
  syncSource, testConnection, listSyncLogs, clearSyncLogs, listSyncRuns,
  listRunEvents, getRun, subscribeRun, deleteRunsBySource
};
