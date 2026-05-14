#!/usr/bin/env node
const Redis = require('ioredis');
const ilanzouApi = require('../services/ilanzouApi');

// ===== 限速：和 services/rateLimiter.js 保持同一套策略 =====
// shareUrl 已废弃（百万级会触发风控），同步只保留 getFileList
// 阶段3：getFileList 30→15/分钟，间隔 600→1500ms，抖动 400→1500ms
const LIMITS = { login: 2, getFileList: 15, default: 15 };
const MIN_INTERVAL_MS = Number(process.env.LZ_MIN_INTERVAL_MS || 1500);
const JITTER_MS = Number(process.env.LZ_JITTER_MS || 1500);

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

    const lk = `ratelimit:last:${accountId}`;
    const last = Number(await r.get(lk) || 0);
    const wait = Math.max(0, MIN_INTERVAL_MS + rand(JITTER_MS) - (Date.now() - last));
    if (wait > 0) await sleep(wait);
    await r.set(lk, String(Date.now()), 'EX', 60);
  } catch (err) {
    if (err.code === 'COOLDOWN' || err.code === 'RATE_LIMITED') throw err;
    await sleep(MIN_INTERVAL_MS + rand(JITTER_MS));
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
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ===== NDJSON 事件输出 =====
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fileToDict(item, parentFolderId) {
  return {
    parent_folder_id: String(parentFolderId ?? 0),
    file_id: String(item.fileId || item.id || ''),
    file_name: String(item.fileName || item.name || ''),
    file_size: String(item.fileSize || item.size || ''),
    file_type: String(item.fileType || item.type || ''),
    file_time: String(item.updTime || item.addTime || item.updateTime || item.createTime || item.time || ''),
    share_url: ''
  };
}

function isFolderItem(item) {
  return Number(item?.fileType || item?.type || 0) === 2 && item?.folderId;
}
function isFileItem(item) {
  return Number(item?.fileType || item?.type || 0) === 1 && (item?.fileId || item?.id);
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

async function main() {
  const input = JSON.parse(await readInput());
  const account = String(input.account || '').trim();
  const password = String(input.password || '');
  const rootFolderId = String(input.rootFolderId || '0');
  const mode = String(input.mode || 'incremental');
  const dailyBudget = Math.max(0, Number(input.dailyCallBudget || 0));
  const resume = (input.resume && typeof input.resume === 'object') ? input.resume : {};
  const initialPending = Array.isArray(input.pendingFolders) && input.pendingFolders.length
    ? input.pendingFolders.map(String)
    : [rootFolderId];

  if (!account || !password) throw new Error('账号或密码为空');

  const accountId = 'ilanzou:' + account;

  // 预热登录（getUuid + login + user/account/map），失败立刻抛
  await acquire(accountId, 'login');
  try {
    await withTimeout(ilanzouApi.getClient(account, password), 25000, '登录');
  } catch (err) {
    if (looksRateLimited({ msg: err && err.message })) await cooldown(accountId, 600);
    throw err;
  }

  // ===== BFS 主循环 =====
  const queue = [...initialPending];
  const enqueued = new Set(queue);
  let callsLeft = dailyBudget;
  let totalFiles = 0;
  let stopReason = 'completed';

  outer:
  while (queue.length > 0) {
    const folderId = queue.shift();
    const state = resume[folderId] || { next_offset: 1, total_page: 0, done: 0 };
    if (state.done) continue; // 已完成的目录跳过
    let offset = Math.max(1, Number(state.next_offset) || 1);
    let totalPage = Math.max(0, Number(state.total_page) || 0);
    const limit = 60; // OpenList 同款

    while (true) {
      if (callsLeft <= 0) {
        // 当前页还没拉，next_offset 维持 offset（下次从这一页继续），done=0
        emit({ event: 'progress', folder_id: folderId, next_offset: offset, total_page: totalPage, done: 0 });
        // 把当前目录退回队首，剩余目录原样保留
        queue.unshift(folderId);
        stopReason = 'daily_quota_reached';
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
        emit({ event: 'progress', folder_id: folderId, next_offset: offset, total_page: totalPage, done: 0 });
        queue.unshift(folderId);
        if (err.code === 'COOLDOWN') {
          stopReason = 'cooldown';
          break outer;
        }
        if (err.code === 'RATE_LIMITED') {
          stopReason = 'rate_limited';
          break outer;
        }
        if (looksRateLimited({ msg: err && err.message })) {
          await cooldown(accountId, 600);
          stopReason = 'cooldown';
          break outer;
        }
        // 其他错误：直接抛，由上层 failRun
        throw err;
      }
      callsLeft--;

      const list = Array.isArray(resp && resp.list) ? resp.list : [];
      totalPage = Number((resp && resp.totalPage) || totalPage);

      for (const item of list) {
        if (isFolderItem(item)) {
          const sub = String(item.folderId);
          if (!enqueued.has(sub)) {
            enqueued.add(sub);
            queue.push(sub);
          }
          continue;
        }
        if (isFileItem(item)) {
          totalFiles++;
          emit({ event: 'file', data: fileToDict(item, folderId) });
        }
      }

      const isLastPage = list.length === 0 || (totalPage > 0 && offset >= totalPage);
      const nextOffset = isLastPage ? offset : (offset + 1);
      const done = isLastPage ? 1 : 0;
      emit({ event: 'progress', folder_id: folderId, next_offset: nextOffset, total_page: totalPage, done });

      if (isLastPage) break;
      offset++;
    }
  }

  emit({
    event: 'end',
    ok: true,
    reason: stopReason,
    total_files: totalFiles,
    total_calls: dailyBudget - callsLeft,
    remaining_folders: queue
  });

  try { await redis && redis.quit(); } catch (_) {}
}

main().catch((err) => {
  emit({ event: 'end', ok: false, message: err?.message || String(err) });
  try { redis && redis.quit(); } catch (_) {}
  process.exit(1);
});
