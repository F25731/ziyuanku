#!/usr/bin/env node
// 蓝奏官方 web 接口同步脚本（参照 OpenList drivers/ilanzou）
// 协议：stdin 接 JSON 输入；stdout 输出 NDJSON 事件流
//   {event:'file',  data:{...}}                          每个文件一条
//   {event:'page',  folder_id, next_offset, total_page, done}   每翻一页一条（含目录扫完）
//   {event:'message', level, event, message, payload}    粒度日志（启动/恢复/失败重试…）
//   {event:'end',   ok, reason, total_files, total_calls, remaining_folders}

const Redis = require('ioredis');
const ilanzouApi = require('../services/ilanzouApi');

// 阶段4：默认不主动限速、不预防 sleep；只对真实风控信号被动 cooldown
// 用户想保守跑可通过 ENV 拉慢
const LIMITS = {
  login: 5,
  getFileList: Number(process.env.LZ_LIST_RPM || 600),
  default: 300
};
const MIN_INTERVAL_MS = Number(process.env.LZ_MIN_INTERVAL_MS || 0);
const JITTER_MS = Number(process.env.LZ_JITTER_MS || 0);

let redis = null;
function getRedis() {
  if (redis) return redis;
  redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: false,
    maxRetriesPerRequest: 2
  });
  redis.on('error', () => {});
  return redis;
}

function rand(max) { return Math.floor(Math.random() * (max + 1)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function logMsg(level, event, message, payload) {
  emit({ event: 'message', level: level || 'info', event_name: event, message: message || '', payload: payload || null });
}

async function acquire(accountId, op = 'default') {
  if (!accountId) return;
  try {
    const r = getRedis();
    const limit = LIMITS[op] || LIMITS.default;

    const cd = await r.get(`ratelimit:cooldown:${accountId}`);
    if (cd) {
      const ttl = await r.ttl(`ratelimit:cooldown:${accountId}`);
      const err = new Error(`账号冷却中 ${ttl}s`);
      err.code = 'COOLDOWN';
      throw err;
    }

    const win = Math.floor(Date.now() / 60000);
    const ck = `ratelimit:cnt:${accountId}:${op}:${win}`;
    const used = await r.incr(ck);
    if (used === 1) await r.expire(ck, 70);
    if (used > limit) {
      const err = new Error(`${op} 超配额(${used}/${limit})`);
      err.code = 'RATE_LIMITED';
      throw err;
    }

    if (MIN_INTERVAL_MS > 0 || JITTER_MS > 0) {
      const lk = `ratelimit:last:${accountId}`;
      const last = Number(await r.get(lk) || 0);
      const wait = Math.max(0, MIN_INTERVAL_MS + rand(JITTER_MS) - (Date.now() - last));
      if (wait > 0) await sleep(wait);
      await r.set(lk, String(Date.now()), 'EX', 60);
    }
  } catch (err) {
    if (err.code === 'COOLDOWN' || err.code === 'RATE_LIMITED') throw err;
    // Redis 失败不阻塞同步：fallback 到本地小延迟
    if (MIN_INTERVAL_MS > 0) await sleep(MIN_INTERVAL_MS + rand(JITTER_MS));
  }
}

async function cooldown(accountId, seconds = 600) {
  try { await getRedis().set(`ratelimit:cooldown:${accountId}`, '1', 'EX', seconds); } catch (_) {}
}

function looksRateLimited(resp) {
  const txt = (resp && (resp.msg || resp.message || '')) || '';
  return /频繁|请求过快|操作过快|验证|封|限制|risk/i.test(txt)
    || (resp && (resp.code === 429 || resp.status === 429));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms))
  ]);
}

async function callWithRetry(accountId, op, fn, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquire(accountId, op);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.code === 'COOLDOWN' || err.code === 'RATE_LIMITED') throw err;
      if (/风控|封|频繁|限制/.test(err.message || '')) throw err;
      if (attempt >= maxRetries) throw err;
      const wait = 1500 * Math.pow(3, attempt) + rand(800);
      logMsg('warn', 'retry', `${op} 失败，第 ${attempt + 1}/${maxRetries} 次重试 (${wait}ms 后)`, { error: err.message });
      await sleep(wait);
    }
  }
  throw lastErr;
}

// 字段约定（参照 OpenList）：fileType==2 文件夹，其他都是文件
function isFolderItem(item) {
  return Number(item?.fileType ?? -1) === 2 && (item?.folderId != null);
}
function isFileItem(item) {
  if (!item) return false;
  if (Number(item.fileType ?? -1) === 2) return false;
  return item.fileId != null || item.id != null;
}

function fileToDict(item, parentFolderId) {
  return {
    parent_folder_id: String(parentFolderId ?? 0),
    file_id: String(item.fileId || item.id || ''),
    file_name: String(item.fileName || item.name || ''),
    file_size: String(item.fileSize || item.size || ''),
    file_type: String(item.fileType ?? item.type ?? ''),
    file_time: String(item.updTime || item.addTime || item.updateTime || item.createTime || item.time || ''),
    share_url: ''
  };
}

async function readInput() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf || '{}'));
    process.stdin.on('error', reject);
  });
}

// 用户从后台点了"暂停"——上层会给本进程发 SIGTERM，
// 这里捕获后只置标志，让主循环把当前页扫完后干净退出（进度照常落库）
let pauseRequested = false;
process.on('SIGTERM', () => { pauseRequested = true; });
process.on('SIGINT',  () => { pauseRequested = true; });

async function main() {
  const input = JSON.parse(await readInput());
  const account = String(input.account || '').trim();
  const password = String(input.password || '');
  const rootFolderId = String(input.rootFolderId || '0');
  const mode = String(input.mode || 'incremental');
  const maxIndexDepth = Math.max(1, Number(input.maxIndexDepth) || 20);
  const resume = (input.resume && typeof input.resume === 'object') ? input.resume : {};
  const depthMap = (input.depthMap && typeof input.depthMap === 'object') ? { ...input.depthMap } : { [rootFolderId]: 0 };
  const initialPending = Array.isArray(input.pendingFolders) && input.pendingFolders.length
    ? input.pendingFolders.map(String)
    : [rootFolderId];

  if (!account || !password) throw new Error('账号或密码为空');

  const accountId = 'ilanzou:' + account;

  // 预热登录
  await acquire(accountId, 'login');
  try {
    await withTimeout(ilanzouApi.getClient(account, password), 25000, '登录');
    logMsg('info', 'login_ok', '账号已登录，开始扫描');
  } catch (err) {
    if (looksRateLimited({ msg: err && err.message })) await cooldown(accountId, 600);
    throw err;
  }

  const queue = [...initialPending];
  const enqueued = new Set(queue);
  // 没有显式 depthMap 项的目录（resume 来的）按"根目录深度"对待，避免被误截断
  for (const f of queue) if (depthMap[f] == null) depthMap[f] = 0;

  let totalFiles = 0;
  let totalCalls = 0;
  let stopReason = 'completed';

  outer:
  while (queue.length > 0) {
    const folderId = queue.shift();
    const state = resume[folderId] || { next_offset: 1, total_page: 0, done: 0 };
    if (state.done) continue;
    const depth = Number(depthMap[folderId] ?? 0);
    let offset = Math.max(1, Number(state.next_offset) || 1);
    let totalPage = Math.max(0, Number(state.total_page) || 0);
    const limit = 60;

    while (true) {
      // 用户从后台点了"暂停"
      if (pauseRequested) {
        emit({ event: 'page', folder_id: folderId, next_offset: offset, total_page: totalPage, done: 0 });
        queue.unshift(folderId);
        logMsg('warn', 'paused_by_user', '用户从后台手动暂停');
        stopReason = 'paused_by_user';
        break outer;
      }
      let resp;
      try {
        resp = await callWithRetry(accountId, 'getFileList',
          () => withTimeout(
            ilanzouApi.listFolderPage(account, password, folderId, offset, limit),
            15000, `record/file/list(${folderId} p${offset})`
          ),
          2
        );
      } catch (err) {
        // 风控/冷却 → 把当前目录退回队首，干净停掉
        emit({ event: 'page', folder_id: folderId, next_offset: offset, total_page: totalPage, done: 0 });
        queue.unshift(folderId);
        if (err.code === 'COOLDOWN') {
          logMsg('warn', 'cooldown', `账号已冷却: ${err.message}`);
          stopReason = 'cooldown';
          break outer;
        }
        if (err.code === 'RATE_LIMITED') {
          logMsg('warn', 'rate_limited', `配额超限: ${err.message}`);
          stopReason = 'rate_limited';
          break outer;
        }
        if (looksRateLimited({ msg: err && err.message })) {
          await cooldown(accountId, 600);
          logMsg('warn', 'cooldown', `命中风控关键词，已冷却 600s: ${err.message}`);
          stopReason = 'cooldown';
          break outer;
        }
        throw err;
      }
      totalCalls++;

      const list = Array.isArray(resp && resp.list) ? resp.list : [];
      totalPage = Number((resp && resp.totalPage) || totalPage);

      let pageFileCount = 0, pageFolderCount = 0;
      for (const item of list) {
        if (isFolderItem(item)) {
          pageFolderCount++;
          // 深度截断：当前目录 depth + 1 > maxIndexDepth 就不入队
          if (depth + 1 <= maxIndexDepth) {
            const sub = String(item.folderId);
            if (!enqueued.has(sub)) {
              enqueued.add(sub);
              depthMap[sub] = depth + 1;
              queue.push(sub);
            }
          }
          continue;
        }
        if (isFileItem(item)) {
          pageFileCount++;
          totalFiles++;
          emit({ event: 'file', data: fileToDict(item, folderId) });
        }
      }

      const isLastPage = list.length === 0 || (totalPage > 0 && offset >= totalPage);
      const nextOffset = isLastPage ? offset : (offset + 1);
      const done = isLastPage ? 1 : 0;
      emit({
        event: 'page',
        folder_id: folderId,
        page: offset,
        total_page: totalPage,
        next_offset: nextOffset,
        done,
        depth,
        page_files: pageFileCount,
        page_folders: pageFolderCount
      });

      if (isLastPage) break;
      offset++;
    }
  }

  emit({
    event: 'end',
    ok: true,
    reason: stopReason,
    total_files: totalFiles,
    total_calls: totalCalls,
    remaining_folders: queue
  });

  try { await redis && redis.quit(); } catch (_) {}
}

main().catch((err) => {
  emit({ event: 'end', ok: false, message: err?.message || String(err) });
  try { redis && redis.quit(); } catch (_) {}
  process.exit(1);
});
