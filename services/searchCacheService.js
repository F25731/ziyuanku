const crypto = require('crypto');
const { getRedis } = require('../config/redis');

const CACHE_TTL = Math.max(0, Number(process.env.SEARCH_CACHE_TTL || 60));
const HOT_TTL = Math.max(CACHE_TTL, Number(process.env.SEARCH_CACHE_HOT_TTL || 600));
const HOT_MIN = Math.max(1, Number(process.env.SEARCH_CACHE_HOT_MIN || 3));
const CACHE_ENABLED = String(process.env.SEARCH_CACHE_ENABLED || '1') !== '0';

function stableAllowedIds(ids) {
  if (!Array.isArray(ids)) return null;
  return ids.map(Number).filter(Boolean).sort((a, b) => a - b);
}

function cacheKey(input) {
  const payload = {
    q: String(input.q || '').trim(),
    page: Number(input.page || 1),
    pageSize: Number(input.pageSize || 20),
    sourceId: input.sourceId ? Number(input.sourceId) : null,
    allowedSourceIds: stableAllowedIds(input.allowedSourceIds),
    cap: Number(input.cap || 0),
    cursor: input.cursor ? String(input.cursor) : '',
    skipTotal: !!input.skipTotal
  };
  const digest = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  return `search:resources:v2:${digest}`;
}

function hotKey(key) {
  return key.replace('search:resources:v2:', 'search:resources:hot:v2:');
}

async function get(input) {
  if (!CACHE_ENABLED || CACHE_TTL <= 0 || !String(input.q || '').trim()) return null;
  try {
    const redis = getRedis();
    const key = cacheKey(input);
    const raw = await redis.get(key);
    const n = await redis.incr(hotKey(key));
    if (n === 1) await redis.expire(hotKey(key), 3600);
    if (!raw) return null;
    if (n >= HOT_MIN) await redis.expire(key, HOT_TTL);
    const data = JSON.parse(raw);
    data.cache_hit = true;
    if (data.engine && !String(data.engine).endsWith('_cache')) {
      data.engine = `${data.engine}_cache`;
    }
    return data;
  } catch (_) {
    return null;
  }
}

async function set(input, value) {
  if (!CACHE_ENABLED || CACHE_TTL <= 0 || !String(input.q || '').trim() || !value) return;
  try {
    const redis = getRedis();
    const key = cacheKey(input);
    const hits = Number(await redis.get(hotKey(key)) || 0);
    await redis.setex(key, hits >= HOT_MIN ? HOT_TTL : CACHE_TTL, JSON.stringify(value));
  } catch (_) {}
}

module.exports = { get, set };
