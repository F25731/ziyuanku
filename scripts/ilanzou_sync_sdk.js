#!/usr/bin/env node
const { LanZouYClient } = require('@netdrive-sdk/ilanzou');
const Redis = require('ioredis');

// ===== 限速：和 services/rateLimiter.js 保持同一套策略 =====
const LIMITS = { shareUrl: 15, login: 2, getFileList: 30, default: 20 };
const MIN_INTERVAL_MS = 600;
const JITTER_MS = 400;

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
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    await r.set(lk, String(Date.now()), 'EX', 60);
  } catch (err) {
    if (err.code === 'COOLDOWN' || err.code === 'RATE_LIMITED') throw err;
    // Redis 挂了不要阻塞同步流程，降级到固定间隔
    await new Promise((res) => setTimeout(res, MIN_INTERVAL_MS + rand(JITTER_MS)));
  }
}

async function cooldown(accountId, seconds = 600) {
  try { await getRedis().set(`ratelimit:cooldown:${accountId}`, '1', 'EX', seconds); } catch (_) {}
}

function looksRateLimited(resp) {
  const txt = (resp && (resp.msg || resp.message || '')) || '';
  return /频繁|请求过快|操作过快|验证|封|限制/.test(txt)
    || (resp && (resp.code === 429 || resp.status === 429));
}

// ===== 工具 =====
function fileToDict(item, parentFolderId, shareUrl = '') {
  return {
    parent_folder_id: String(parentFolderId ?? 0),
    file_id: String(item.fileId || item.id || ''),
    file_name: String(item.fileName || item.name || ''),
    file_size: String(item.fileSize || item.size || ''),
    file_type: String(item.fileType || item.type || ''),
    file_time: String(item.updTime || item.addTime || item.updateTime || item.createTime || item.time || ''),
    share_url: String(shareUrl || '').trim()
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms))
  ]);
}

async function safeShareUrl(client, accountId, fileId) {
  try {
    await acquire(accountId, 'shareUrl');
  } catch (err) {
    if (err.code === 'COOLDOWN') throw err; // 冷却期直接停，上层捕获
    return '';
  }
  try {
    const res = await withTimeout(client.shareUrl(String(fileId || '')), 12000, 'shareUrl');
    if (looksRateLimited(res)) {
      await cooldown(accountId, 600);
      return '';
    }
    return String((res && res.shareUrl) || '').trim();
  } catch (_) {
    return '';
  }
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

function isFolderItem(item) {
  return Number(item?.fileType || item?.type || 0) === 2 && item?.folderId;
}
function isFileItem(item) {
  return Number(item?.fileType || item?.type || 0) === 1 && (item?.fileId || item?.id);
}

async function fetchAllInFolder(ctx, folderId) {
  const all = [];
  const limit = 100;
  let offset = 1;
  while (true) {
    await acquire(ctx.accountId, 'getFileList');
    const res = await withTimeout(
      ctx.client.getFileList({ folderId, limit, offset }), 15000, `getFileList(${folderId})`
    );
    if (!res || res.code !== 200) {
      if (looksRateLimited(res)) {
        await cooldown(ctx.accountId, 600);
        throw new Error('风控触发，已冷却账号');
      }
      throw new Error((res && (res.msg || res.message)) || `ilanzou 列表获取失败, folderId=${folderId}`);
    }
    const list = Array.isArray(res.list) ? res.list : [];
    all.push(...list);
    const total = Number(res.total || 0);
    if (list.length === 0) break;
    if (total > 0 && all.length >= total) break;
    offset += list.length;
    if (list.length < limit && total === 0) break;
  }
  return all;
}

async function walk(ctx, folderId, files, visited) {
  const key = String(folderId ?? 0);
  if (visited.has(key)) return;
  visited.add(key);
  const items = await fetchAllInFolder(ctx, Number(folderId || 0));
  for (const item of items) {
    if (isFolderItem(item)) {
      await walk(ctx, Number(item.folderId), files, visited);
      continue;
    }
    if (isFileItem(item)) {
      const fileId = String(item.fileId || item.id || '');
      let shareUrl = '';
      if (ctx.mode === 'incremental' && ctx.existing && ctx.existing[fileId]) {
        shareUrl = ctx.existing[fileId];
      } else if (ctx.mode !== 'check-only' && fileId) {
        shareUrl = await safeShareUrl(ctx.client, ctx.accountId, fileId);
      }
      files.push(fileToDict(item, folderId, shareUrl));
    }
  }
}

async function main() {
  const input = JSON.parse(await readInput());
  const account = String(input.account || '').trim();
  const password = String(input.password || '');
  const rootFolderId = Number(input.rootFolderId || 0);
  const mode = String(input.mode || 'full');
  const existing = input.existing && typeof input.existing === 'object' ? input.existing : {};

  if (!account || !password) throw new Error('账号或密码为空');

  const accountId = 'ilanzou:' + account;
  const client = new LanZouYClient({ username: account, password });
  client.config.apiUrl = 'https://apis.ilanzou.com';
  client.client = client.client.extend({ prefixUrl: client.config.apiUrl });

  await acquire(accountId, 'login');
  const loginRes = await withTimeout(client.login(), 20000, '登录');
  if (!loginRes || loginRes.code !== 200) {
    if (looksRateLimited(loginRes)) await cooldown(accountId, 600);
    throw new Error((loginRes && (loginRes.msg || loginRes.message)) || 'ilanzou 登录失败');
  }

  const files = [];
  await walk({ client, accountId, mode, existing }, rootFolderId, files, new Set());

  const reused = files.filter((f) => existing[f.file_id]).length;
  const newOnes = files.length - reused;
  process.stdout.write(JSON.stringify({
    ok: true, total: files.length, reused, new: newOnes, mode, files
  }));
  try { await redis && redis.quit(); } catch (_) {}
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, message: err?.message || String(err) }));
  try { redis && redis.quit(); } catch (_) {}
  process.exit(1);
});
