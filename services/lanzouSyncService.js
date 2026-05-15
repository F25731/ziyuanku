const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { getSource } = require('./sourceService');
const { upsertResources, reconcileDeletedAfterRun } = require('./resourceService');
const ilanzouApi = require('./ilanzouApi');
const HttpError = require('../utils/httpError');

// 阶段4：抛弃每日预算闸门，对齐 OpenList 风格——一次跑到底，
// 真触发风控才退避。保留断点续扫（崩溃/网络抖动总会有）。
// 1G 容器内必须严格背压：批次小、不主动写事件流（前端靠 GET sync-status 轮询）
const UPSERT_BATCH = Math.max(50, Number(process.env.SYNC_UPSERT_BATCH || 200));
const DEFAULT_MAX_DEPTH = Math.max(1, Number(process.env.SYNC_MAX_INDEX_DEPTH || 20));
const PROGRESS_LAST_MSG_INTERVAL_MS = 5000; // 5s 写一次 last_message，让前端轮询能看到最新概要

function toSyncHash(item) {
  return crypto.createHash('md5')
    .update([item.file_id || '', item.file_name || '', item.share_url || ''].join('|'))
    .digest('hex');
}

// 把简短"概要句"写到 sync_runs.last_message，前端轮询时能看到（不再走 sync_run_events 表）
async function setLastMessage(runId, msg) {
  if (!runId) return;
  try {
    await pool.query(
      'UPDATE sync_runs SET last_message=? WHERE id=?',
      [String(msg || '').slice(0, 500), runId]
    );
  } catch (err) {
    // last_message 是次要字段，失败静默
  }
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

// ===== 进行中 run -> 子进程引用映射，用于支持手动暂停 =====
const runningProcs = new Map(); // runId -> { child, paused: false }

function requestPause(runId) {
  const entry = runningProcs.get(Number(runId));
  if (!entry || !entry.child) return false;
  if (entry.paused) return true;
  entry.paused = true;
  try {
    // 用一个独立的控制管道发暂停信号：写到子进程的 stdin
    // 注意：子进程 main() 已经把 stdin 读完，第二次 write 会失败 → 改用环境标志不可行
    // 这里改成直接给子进程发 SIGTERM，子进程注册 handler 捕获后干净退出
    entry.child.kill('SIGTERM');
  } catch (_) {}
  return true;
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
    if (syncRunId) runningProcs.set(syncRunId, { child, paused: false });

    let stderr = '';
    let endEvent = null;
    let lineErr = null;

    // 串行处理 NDJSON 行：readline 不会等 async handler，需要自己用队列把 onFile/onPage 串起来
    // 任何时刻只有 1 个 handler 在运行，避免 batch 在 flush 期间无限堆积
    const rl = readline.createInterface({ input: child.stdout });
    let processChain = Promise.resolve();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return;
      let evt;
      try { evt = JSON.parse(trimmed); } catch (_) { return; }
      processChain = processChain.then(async () => {
        try {
          if (evt.event === 'file') {
            await onFile(evt.data, child);
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
    });

    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => {
      if (syncRunId) runningProcs.delete(syncRunId);
      reject(err);
    });
    child.on('close', async (code, signal) => {
      const wasPaused = syncRunId && runningProcs.get(syncRunId)?.paused;
      if (syncRunId) runningProcs.delete(syncRunId);
      // 等所有排队中的事件处理完
      try { await processChain; } catch (_) {}
      if (lineErr) return reject(lineErr);
      if (signal === 'SIGTERM' || wasPaused) {
        return resolve(endEvent || { ok: true, reason: 'paused_by_user', total_files: 0, total_calls: 0, remaining_folders: [] });
      }
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

// 给"前端轮询用"的进度快照：单条 SQL 拉齐当前最近 run + 目录维度的进度统计
// 客户端每 2s 调一次，常驻在 source 行下方的进度卡上显示
async function getSyncStatus(sourceId) {
  const [[run]] = await pool.query(
    `SELECT id, source_id, mode, status, root_folder_id, max_index_depth,
            total_calls, total_files, last_message,
            started_at, last_resume_at, paused_at, finished_at
       FROM sync_runs
      WHERE source_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [sourceId]
  );
  if (!run) {
    return { has_run: false, status: 'idle', is_active: false };
  }
  const [[prog]] = await pool.query(
    `SELECT
        COUNT(*) AS total_dirs,
        COALESCE(SUM(done), 0) AS done_dirs,
        MAX(updated_at) AS last_update_at
       FROM sync_progress
      WHERE run_id = ?`,
    [run.id]
  );
  // current_folder：取最近一次有更新但未 done 的目录
  const [[cur]] = await pool.query(
    `SELECT folder_id, next_offset, total_page
       FROM sync_progress
      WHERE run_id = ? AND done = 0
      ORDER BY last_pulled_at DESC
      LIMIT 1`,
    [run.id]
  );

  // 是否真在跑：看进程内是否有该 run 的 child（避免容器重启后状态停留 running）
  const isAlive = runningProcs.has(Number(run.id));
  let status = run.status;
  if (status === 'running' && !isAlive) {
    // 数据库里 running 但进程内已经没了 → 容器重启过，run 实际上是孤儿
    status = 'orphaned';
  }

  return {
    has_run: true,
    is_active: status === 'running' && isAlive,
    run_id: run.id,
    status,
    mode: run.mode,
    last_message: run.last_message,
    started_at: run.started_at,
    last_resume_at: run.last_resume_at,
    paused_at: run.paused_at,
    finished_at: run.finished_at,
    total_calls: Number(run.total_calls) || 0,
    total_files: Number(run.total_files) || 0,
    max_index_depth: run.max_index_depth,
    progress: {
      total_dirs: Number(prog.total_dirs) || 0,
      done_dirs: Number(prog.done_dirs) || 0,
      pending_dirs: (Number(prog.total_dirs) || 0) - (Number(prog.done_dirs) || 0),
      last_update_at: prog.last_update_at,
      current_folder_id: cur ? cur.folder_id : null,
      current_folder_next_offset: cur ? Number(cur.next_offset) : null,
      current_folder_total_page: cur ? Number(cur.total_page) : null
    }
  };
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

  await setLastMessage(run.id, `${mode} 启动 (max_depth=${maxDepth})，待扫目录=${pending.length}`);

  // 流式入库分批缓冲
  let batch = [];
  let totalFiles = 0;     // 真正已 flush 入库的文件数
  let totalCalls = 0;     // 真正完成的 list 调用数
  let committedCalls = 0; // 已 += 到 sync_runs.total_calls 的快照
  let committedFiles = 0; // 已 += 到 sync_runs.total_files 的快照
  let lastSummaryAt = Date.now();

  const flush = async () => {
    if (!batch.length) return;
    const items = batch.map((f) => ({ ...f, sync_hash: toSyncHash(f) }));
    await upsertResources(sourceId, items);
    totalFiles += items.length;
    batch = [];
  };

  // 5s 节流：把自上次以来的"增量"写到 sync_runs.total_calls/total_files + last_message
  // 这样前端 GET sync-status 轮询能看到数字一直在涨
  const flushCountersToDb = async (msg) => {
    const dCalls = totalCalls - committedCalls;
    const dFiles = totalFiles - committedFiles;
    if (dCalls > 0 || dFiles > 0) {
      await bumpRunCounters(run.id, dCalls, dFiles);
      committedCalls = totalCalls;
      committedFiles = totalFiles;
    }
    if (msg) await setLastMessage(run.id, msg);
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
        if (Date.now() - lastSummaryAt >= PROGRESS_LAST_MSG_INTERVAL_MS) {
          lastSummaryAt = Date.now();
          // 先 flush batch 让 totalFiles 对得上
          await flush();
          await flushCountersToDb(
            `当前 folder=${p.folder_id} 第 ${Math.max(1, p.next_offset - 1)}/${p.total_page || '?'} 页`
          );
        }
      },
      onMessage: async (m) => {
        if (m && m.message) await setLastMessage(run.id, String(m.message).slice(0, 500));
      }
    });

    await flush();
    await flushCountersToDb(null);

    if (endEvt.reason === 'completed') {
      let marked = 0;
      try {
        const r = await reconcileDeletedAfterRun(sourceId, run.started_at);
        marked = r.marked || 0;
      } catch (e) {
        console.warn('[reconcileDeletedAfterRun] 失败:', e.message);
      }
      const msg = `run#${run.id} 已完成: 累计文件 ${totalFiles}, list 调用 ${totalCalls}, 标记已删除 ${marked}`;
      await completeRun(run.id, msg);
      await finishSyncLog(logId, 'success', msg, totalFiles);
      return { run_id: run.id, status: 'completed', total: totalFiles, calls: totalCalls, deleted_marked: marked };
    }
    const reasonLabel = endEvt.reason === 'paused_by_user' ? '用户手动暂停' : `(${endEvt.reason})`;
    const msg = `run#${run.id} 暂停 ${reasonLabel}: 本次新增 ${totalFiles}, list 调用 ${totalCalls}, 剩余目录 ${(endEvt.remaining_folders || []).length}`;
    await pauseRun(run.id, msg);
    await finishSyncLog(logId, 'success', msg, totalFiles);
    return { run_id: run.id, status: 'paused', reason: endEvt.reason, total: totalFiles, calls: totalCalls };
  } catch (err) {
    try { await flush(); } catch (_) {}
    try { await flushCountersToDb(null); } catch (_) {}
    const msg = err && err.message || String(err);
    if (/冷却|风控|频繁|限制|429/i.test(msg)) {
      await pauseRun(run.id, '触发风控/冷却: ' + msg);
      await finishSyncLog(logId, 'failed', msg, totalFiles);
    } else {
      await failRun(run.id, msg);
      await finishSyncLog(logId, 'failed', msg, totalFiles);
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
  getRun, deleteRunsBySource, requestPause, getSyncStatus
};
