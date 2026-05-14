const { getRedis } = require('../config/redis');

// 每个账号每分钟配额（按操作分类）
// 阶段3：百万级扫描需要慢且像人——单点限制再放紧一档
const DEFAULT_LIMITS = {
  login: 2,
  getFileList: 15,    // 原 30，对齐 OpenList 风格的随手翻目录
  downloadFile: 20,
  default: 15
};

const MIN_INTERVAL_MS = Number(process.env.LZ_MIN_INTERVAL_MS || 1500); // 原 600
const JITTER_MS = Number(process.env.LZ_JITTER_MS || 1500);             // 原 400

// 同账号信号量（同时最多 N 个 SDK 请求在飞）
const ACCOUNT_CONCURRENCY = 1;

function rand(max) { return Math.floor(Math.random() * (max + 1)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cooldownKey(accountId) { return `ratelimit:cooldown:${accountId}`; }
function cooldownReasonKey(accountId) { return `ratelimit:cooldown:reason:${accountId}`; }
function counterKey(accountId, op) {
  const win = Math.floor(Date.now() / 60000);
  return `ratelimit:cnt:${accountId}:${op}:${win}`;
}
function lastCallKey(accountId) { return `ratelimit:last:${accountId}`; }
function recentFailKey(accountId) { return `ratelimit:recentfail:${accountId}`; }

// ===== 进程内信号量：账号级排队 =====
const accountQueues = new Map();
function acquireSlot(accountId) {
  if (!accountId) return Promise.resolve(() => {});
  let queue = accountQueues.get(accountId);
  if (!queue) {
    queue = { active: 0, waiting: [] };
    accountQueues.set(accountId, queue);
  }
  return new Promise((resolve) => {
    const tryGrant = () => {
      if (queue.active < ACCOUNT_CONCURRENCY) {
        queue.active++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          queue.active--;
          const next = queue.waiting.shift();
          if (next) next();
        };
        resolve(release);
      } else {
        queue.waiting.push(tryGrant);
      }
    };
    tryGrant();
  });
}

// ===== acquire：配额 + 间隔 + 抖动 =====
async function acquire(accountId, op = 'default') {
  if (!accountId) return;
  const redis = getRedis();
  const limit = DEFAULT_LIMITS[op] || DEFAULT_LIMITS.default;

  const cd = await redis.get(cooldownKey(accountId));
  if (cd) {
    const ttl = await redis.ttl(cooldownKey(accountId));
    const reason = (await redis.get(cooldownReasonKey(accountId))) || '触发风控';
    const err = new Error(`账号冷却中 ${ttl}s（${reason}）`);
    err.code = 'COOLDOWN';
    err.cooldownTtl = ttl;
    throw err;
  }

  const ck = counterKey(accountId, op);
  const used = await redis.incr(ck);
  if (used === 1) await redis.expire(ck, 70);
  if (used > limit) {
    const err = new Error(`${op} 超过每分钟配额 (${used}/${limit})`);
    err.code = 'RATE_LIMITED';
    err.op = op;
    throw err;
  }

  const lk = lastCallKey(accountId);
  const last = Number(await redis.get(lk) || 0);
  const wait = Math.max(0, MIN_INTERVAL_MS + rand(JITTER_MS) - (Date.now() - last));
  if (wait > 0) await sleep(wait);
  await redis.set(lk, String(Date.now()), 'EX', 60);
}

async function cooldown(accountId, seconds = 600, reason = '触发蓝奏风控') {
  if (!accountId) return;
  try {
    await getRedis().set(cooldownKey(accountId), '1', 'EX', seconds);
    await getRedis().set(cooldownReasonKey(accountId), reason, 'EX', seconds);
    console.warn(`[rateLimiter] ${accountId} 冷却 ${seconds}s, reason: ${reason}`);
  } catch (_) {}
}

async function clearCooldown(accountId) {
  if (!accountId) return;
  try {
    await getRedis().del(cooldownKey(accountId), cooldownReasonKey(accountId), recentFailKey(accountId));
  } catch (_) {}
}

function looksRateLimited(resp, err) {
  const txt = (resp && (resp.msg || resp.message || '')) || (err && err.message) || '';
  if (/频繁|请求过快|操作过快|验证|封|限制|risk/i.test(txt)) return true;
  if (err && (err.statusCode === 429 || err.status === 429)) return true;
  if (resp && (resp.code === 429 || resp.status === 429)) return true;
  return false;
}

// 滚动失败计数：5 分钟内连续 5 次失败就主动冷却（即使关键词没匹配上）
async function recordFailure(accountId) {
  if (!accountId) return 0;
  try {
    const r = getRedis();
    const k = recentFailKey(accountId);
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, 300);
    return n;
  } catch (_) { return 0; }
}

// ===== 简单 guarded：占额 → 执行 → 检测风控（不重试）=====
async function guarded(accountId, op, fn) {
  await acquire(accountId, op);
  const release = await acquireSlot(accountId);
  try {
    const r = await fn();
    if (looksRateLimited(r, null)) {
      await cooldown(accountId, 600, op + ' 响应含风控关键词');
      const e = new Error('触发蓝奏风控: ' + JSON.stringify(r));
      e.code = 'THROTTLED';
      throw e;
    }
    return r;
  } catch (err) {
    if (looksRateLimited(null, err)) {
      await cooldown(accountId, 600, op + ' 抛错含风控关键词');
    } else {
      const fails = await recordFailure(accountId);
      if (fails >= 5) {
        await cooldown(accountId, 300, '5 分钟内累计 5 次失败');
      }
    }
    throw err;
  } finally {
    release();
  }
}

// ===== 带指数退避重试的 guarded =====
async function guardedWithRetry(accountId, op, fn, options = {}) {
  const maxRetries = options.maxRetries == null ? 2 : options.maxRetries;
  const baseBackoffMs = options.baseBackoffMs || 800;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await guarded(accountId, op, fn);
    } catch (err) {
      lastErr = err;
      // 风控/冷却/超配额 → 不重试
      if (err.code === 'THROTTLED' || err.code === 'COOLDOWN' || err.code === 'RATE_LIMITED') throw err;
      // 最后一轮 → 抛错
      if (attempt >= maxRetries) throw err;
      const wait = baseBackoffMs * Math.pow(3, attempt) + rand(400);
      console.warn(`[rateLimiter] ${accountId} ${op} 失败重试 ${attempt + 1}/${maxRetries}，${wait}ms 后再试: ${err.message}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ===== 健康检查（供 sourceService 显示状态）=====
async function getHealth(accountId) {
  if (!accountId) return null;
  try {
    const r = getRedis();
    const cd = await r.get(cooldownKey(accountId));
    if (cd) {
      const ttl = await r.ttl(cooldownKey(accountId));
      const reason = (await r.get(cooldownReasonKey(accountId))) || '';
      return { status: 'cooldown', cooldown_ttl: ttl, reason };
    }
    const fails = Number((await r.get(recentFailKey(accountId))) || 0);
    if (fails >= 3) return { status: 'warning', recent_fails: fails };
    return { status: 'healthy', recent_fails: fails };
  } catch (_) {
    return { status: 'unknown' };
  }
}

module.exports = {
  acquire, cooldown, clearCooldown, guarded, guardedWithRetry,
  acquireSlot, looksRateLimited, getHealth, DEFAULT_LIMITS
};
