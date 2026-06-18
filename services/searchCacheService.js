const crypto = require('crypto');
const { getRedis } = require('../config/redis');

const CACHE_TTL = Math.max(0, Number(process.env.SEARCH_CACHE_TTL || 60));
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

async function get(input) {
  if (!CACHE_ENABLED || CACHE_TTL <= 0 || !String(input.q || '').trim()) return null;
  try {
    const raw = await getRedis().get(cacheKey(input));
    if (!raw) return null;
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
    await getRedis().setex(cacheKey(input), CACHE_TTL, JSON.stringify(value));
  } catch (_) {}
}

module.exports = { get, set };
