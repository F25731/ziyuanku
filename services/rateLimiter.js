const { getRedis } = require('../config/redis');

// 每个账号每个操作的默认配额（每分钟次数）。保守起步，上去后可以按实际风控情况调。
const DEFAULT_LIMITS = {
  shareUrl: 15,      // 最敏感，一批只拉 15 个/分钟
  login: 2,          // 登录接口，越少越好
  getFileList: 30,   // 列目录相对安全
  downloadFile: 20,  // 换直链
  default: 20
};

// 最小请求间隔（毫秒），所有操作都会等到 >= 这个间隔再放行，配合抖动破节奏
const MIN_INTERVAL_MS = 600;
const JITTER_MS = 400;  // 0~400ms 随机抖动

function rand(max) { return Math.floor(Math.random() * (max + 1)); }

function cooldownKey(accountId) { return `ratelimit:cooldown:${accountId}`; }
function counterKey(accountId, op) {
  const win = Math.floor(Date.now() / 60000);
  return `ratelimit:cnt:${accountId}:${op}:${win}`;
}
function lastCallKey(accountId) { return `ratelimit:last:${accountId}`; }

/**
 * 获取一次蓝奏 API 调用许可。调用方法：
 *   await acquire('account:foo@bar.com', 'shareUrl');
 * 内部做三件事：
 *   1) 检查账号是否在冷却中（被风控后自动冷却）
 *   2) 检查本分钟配额
 *   3) 与上次请求间隔 >= MIN_INTERVAL_MS + jitter
 * 超配额时抛错（Err.code='RATE_LIMITED'），调用方捕获后降级 / 跳过。
 */
async function acquire(accountId, op = 'default') {
  if (!accountId) return; // 没有账号 id（如公开链接模式）就跳过
  const redis = getRedis();
  const limit = DEFAULT_LIMITS[op] || DEFAULT_LIMITS.default;

  // 1) 冷却检查
  const cd = await redis.get(cooldownKey(accountId));
  if (cd) {
    const err = new Error(`账号被风控冷却中，剩余 ${await redis.ttl(cooldownKey(accountId))}s`);
    err.code = 'COOLDOWN';
    throw err;
  }

  // 2) 分钟配额
  const ck = counterKey(accountId, op);
  const used = await redis.incr(ck);
  if (used === 1) await redis.expire(ck, 70);
  if (used > limit) {
    const err = new Error(`${op} 超过每分钟配额 (${used}/${limit})`);
    err.code = 'RATE_LIMITED';
    err.op = op;
    throw err;
  }

  // 3) 最小间隔 + 抖动
  const lk = lastCallKey(accountId);
  const last = Number(await redis.get(lk) || 0);
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS + rand(JITTER_MS) - (now - last));
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  await redis.set(lk, String(Date.now()), 'EX', 60);
}

/**
 * 主动把账号打入冷却（检测到风控关键词时调用）
 */
async function cooldown(accountId, seconds = 600) {
  if (!accountId) return;
  try {
    await getRedis().set(cooldownKey(accountId), '1', 'EX', seconds);
    console.warn(`[rateLimiter] 账号 ${accountId} 进入冷却 ${seconds}s`);
  } catch (_) {}
}

/**
 * 根据 API 响应自动判断是否需要冷却（含风控关键词 / HTTP 429）
 */
function looksRateLimited(resp, err) {
  const txt = (resp && (resp.msg || resp.message || '')) || (err && err.message) || '';
  if (/频繁|请求过快|操作过快|验证|封|限制/.test(txt)) return true;
  if (err && (err.statusCode === 429 || err.status === 429)) return true;
  if (resp && (resp.code === 429 || resp.status === 429)) return true;
  return false;
}

/**
 * 包装一次蓝奏调用：acquire → 执行 → 按响应判断是否进冷却
 */
async function guarded(accountId, op, fn) {
  await acquire(accountId, op);
  try {
    const r = await fn();
    if (looksRateLimited(r, null)) {
      await cooldown(accountId, 600);
      const e = new Error('触发蓝奏风控: ' + JSON.stringify(r));
      e.code = 'THROTTLED';
      throw e;
    }
    return r;
  } catch (err) {
    if (looksRateLimited(null, err)) {
      await cooldown(accountId, 600);
    }
    throw err;
  }
}

module.exports = { acquire, cooldown, guarded, looksRateLimited, DEFAULT_LIMITS };
