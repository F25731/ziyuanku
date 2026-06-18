const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { getRedis } = require('../config/redis');
const HttpError = require('../utils/httpError');

const AUTH_CACHE_TTL = Math.max(30, Number(process.env.API_KEY_CACHE_TTL || 300));
const LOG_FLUSH_INTERVAL_MS = Math.max(500, Number(process.env.API_LOG_FLUSH_INTERVAL_MS || 2000));
const LOG_FLUSH_BATCH = Math.max(50, Number(process.env.API_LOG_FLUSH_BATCH || 500));
const LOG_QUEUE_MAX = Math.max(LOG_FLUSH_BATCH, Number(process.env.API_LOG_QUEUE_MAX || 20000));

const logQueue = [];
let logFlushTimer = null;
let flushingLogs = false;

function generatePlainKey() {
  const buf = crypto.randomBytes(32);
  return 'lhk_' + buf.toString('base64')
    .replace(/\+/g, '')
    .replace(/\//g, '')
    .replace(/=/g, '')
    .slice(0, 40);
}

function prefixOf(plain) {
  return String(plain).slice(0, 12);
}

function hashPlainForCache(plain) {
  return crypto.createHash('sha256').update(String(plain || '')).digest('hex');
}

function authCacheKey(plain) {
  return `api_key:auth:${hashPlainForCache(plain)}`;
}

function authCacheIndexKey(id) {
  return `api_key:auth_index:${id}`;
}

function dailyQuotaKey(id, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `api_key:quota:daily:${id}:${y}${m}${d}`;
}

function totalQuotaKey(id) {
  return `api_key:quota:total:${id}`;
}

function secondsUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000) + 3600);
}

async function hashKey(plain) {
  return bcrypt.hash(String(plain), 8);
}

async function compareKey(plain, hash) {
  return bcrypt.compare(String(plain), hash);
}

function parseAllowedSourceIds(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) {
    const arr = raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
    return arr.length ? Array.from(new Set(arr)) : null;
  }
  const arr = String(raw).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return arr.length ? Array.from(new Set(arr)) : null;
}

function stringifyAllowedSourceIds(arr) {
  if (!arr || !arr.length) return null;
  return arr.join(',');
}

async function cacheApiKeyAuth(plain, row) {
  if (!plain || !row || !row.id) return;
  try {
    const redis = getRedis();
    const key = authCacheKey(plain);
    await redis.setex(key, AUTH_CACHE_TTL, JSON.stringify(row));
    await redis.sadd(authCacheIndexKey(row.id), key);
    await redis.expire(authCacheIndexKey(row.id), AUTH_CACHE_TTL + 60);
  } catch (_) {}
}

async function getCachedApiKeyAuth(plain) {
  try {
    const raw = await getRedis().get(authCacheKey(plain));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function invalidateApiKeyCache(id) {
  if (!id) return;
  try {
    const redis = getRedis();
    const idx = authCacheIndexKey(id);
    const keys = await redis.smembers(idx);
    if (keys.length) await redis.del(...keys);
    await redis.del(idx);
  } catch (_) {}
}

async function getTotalUsage(apiKeyId, seed = 0) {
  const key = totalQuotaKey(apiKeyId);
  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    if (cached != null) return Number(cached) || 0;
    const total = Number(seed) || 0;
    await redis.set(key, String(total));
    return total;
  } catch (_) {
    return Number(seed) || 0;
  }
}

async function createApiKey({ name, dailyLimit = 0, totalLimit = 0, ratePerMin = 60, maxResults = 1000, allowedSourceIds = null, remark = '', expireDays = 30, ownerUserId = null }) {
  if (!name) throw new HttpError(400, '名称必填');
  const plain = generatePlainKey();
  const prefix = prefixOf(plain);
  const keyHash = await hashKey(plain);

  const days = Number(expireDays);
  const expireSql = (Number.isFinite(days) && days > 0) ? `DATE_ADD(NOW(), INTERVAL ${Math.floor(days)} DAY)` : 'NULL';
  const allowedStr = stringifyAllowedSourceIds(parseAllowedSourceIds(allowedSourceIds));
  const cap = Math.max(1, Math.min(10000, Number(maxResults) || 1000));

  const [result] = await pool.query(
    `INSERT INTO api_keys (name, key_prefix, key_hash, owner_user_id, daily_limit, total_limit, rate_per_min, max_results, allowed_source_ids, remark, expire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${expireSql})`,
    [name, prefix, keyHash, ownerUserId, Number(dailyLimit) || 0, Number(totalLimit) || 0, Number(ratePerMin) || 60, cap, allowedStr, remark || null]
  );
  const id = result.insertId;
  const [[row]] = await pool.query('SELECT expire_at FROM api_keys WHERE id = ?', [id]);
  return {
    id,
    name,
    plain_key: plain,
    key_prefix: prefix,
    daily_limit: Number(dailyLimit) || 0,
    total_limit: Number(totalLimit) || 0,
    rate_per_min: Number(ratePerMin) || 60,
    max_results: cap,
    allowed_source_ids: allowedStr,
    expire_at: row ? row.expire_at : null,
    remark,
    warning: '请妥善保存：完整 key 只会显示这一次'
  };
}

async function extendExpire(id, days) {
  const n = Math.floor(Number(days) || 0);
  if (n <= 0) throw new HttpError(400, '天数必须 > 0');
  const [[row]] = await pool.query('SELECT expire_at FROM api_keys WHERE id = ? LIMIT 1', [id]);
  if (!row) throw new HttpError(404, 'Key 不存在');
  const now = Date.now();
  let baseSql;
  if (!row.expire_at) {
    return { id, expire_at: null, message: '该 Key 永不过期，无需延长' };
  }
  const expMs = new Date(row.expire_at).getTime();
  if (expMs < now) baseSql = `DATE_ADD(NOW(), INTERVAL ${n} DAY)`;
  else baseSql = `DATE_ADD(expire_at, INTERVAL ${n} DAY)`;

  await pool.query(`UPDATE api_keys SET expire_at = ${baseSql} WHERE id = ?`, [id]);
  await invalidateApiKeyCache(id);
  const [[updated]] = await pool.query('SELECT expire_at FROM api_keys WHERE id = ?', [id]);
  return { id, expire_at: updated.expire_at, added_days: n };
}

async function listApiKeys() {
  const [rows] = await pool.query(
    `SELECT id, name, key_prefix, owner_user_id, daily_limit, total_limit, rate_per_min,
            max_results, allowed_source_ids,
            used_total, status, remark, expire_at, last_used_at, created_at
       FROM api_keys ORDER BY id DESC LIMIT 500`
  );
  return rows;
}

async function getByPrefix(prefix) {
  const [rows] = await pool.query(
    'SELECT * FROM api_keys WHERE key_prefix = ? AND status = 1 LIMIT 1',
    [prefix]
  );
  return rows[0] || null;
}

async function verifyPlainKey(plain) {
  if (!plain) return null;
  const cached = await getCachedApiKeyAuth(plain);
  if (cached) {
    if (cached.expire_at && new Date(cached.expire_at).getTime() < Date.now()) return null;
    if (cached.total_limit > 0) {
      const total = await getTotalUsage(cached.id, cached.used_total);
      cached.used_total = total;
      if (total >= cached.total_limit) return { ...cached, __exhausted: true };
    }
    return cached;
  }

  const prefix = prefixOf(plain);
  const row = await getByPrefix(prefix);
  if (!row) return null;
  const ok = await compareKey(plain, row.key_hash);
  if (!ok) return null;
  if (row.expire_at && new Date(row.expire_at).getTime() < Date.now()) return null;

  await cacheApiKeyAuth(plain, row);
  const totalUsed = row.total_limit > 0 ? await getTotalUsage(row.id, row.used_total) : Number(row.used_total) || 0;
  row.used_total = totalUsed;
  if (row.total_limit > 0 && totalUsed >= row.total_limit) {
    return { ...row, __exhausted: true };
  }
  return row;
}

async function disableApiKey(id) {
  await pool.query('UPDATE api_keys SET status = 0 WHERE id = ?', [id]);
  await invalidateApiKeyCache(id);
}

async function enableApiKey(id) {
  await pool.query('UPDATE api_keys SET status = 1 WHERE id = ?', [id]);
  await invalidateApiKeyCache(id);
}

async function deleteApiKey(id) {
  await pool.query('DELETE FROM api_keys WHERE id = ?', [id]);
  await invalidateApiKeyCache(id);
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    flushCallLogs().catch((e) => console.warn('[flushCallLogs]', e.message));
  }, LOG_FLUSH_INTERVAL_MS);
  if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref();
}

async function incrementQuotaUsage(apiKeyId) {
  if (!apiKeyId) return;
  try {
    const redis = getRedis();
    const dKey = dailyQuotaKey(apiKeyId);
    const tKey = totalQuotaKey(apiKeyId);
    const n = await redis.incr(dKey);
    if (n === 1) await redis.expire(dKey, secondsUntilTomorrow());
    await redis.incr(tKey);
  } catch (_) {}
}

async function flushCallLogs() {
  if (flushingLogs || !logQueue.length) return;
  flushingLogs = true;
  const batch = logQueue.splice(0, LOG_FLUSH_BATCH);
  try {
    const values = batch.map((x) => [
      x.apiKeyId || null,
      String(x.path || '').slice(0, 255),
      String(x.ip || '').slice(0, 64),
      Number(x.statusCode) || 0,
      Number(x.ms) || 0,
      x.isQuota ? 1 : 0
    ]);
    if (values.length) {
      await pool.query(
        'INSERT INTO api_call_logs (api_key_id, path, ip, status_code, ms, is_quota) VALUES ?',
        [values]
      );
    }

    const quotaCounts = new Map();
    const touched = new Set();
    for (const x of batch) {
      if (!x.apiKeyId) continue;
      const id = Number(x.apiKeyId);
      touched.add(id);
      if (x.isQuota) quotaCounts.set(id, (quotaCounts.get(id) || 0) + 1);
    }

    for (const [id, count] of quotaCounts) {
      await pool.query(
        'UPDATE api_keys SET used_total = used_total + ?, last_used_at = NOW() WHERE id = ?',
        [count, id]
      );
      touched.delete(id);
    }

    if (touched.size) {
      const ids = Array.from(touched);
      await pool.query(
        `UPDATE api_keys SET last_used_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }
  } finally {
    flushingLogs = false;
    if (logQueue.length >= LOG_FLUSH_BATCH) {
      setImmediate(() => flushCallLogs().catch((e) => console.warn('[flushCallLogs]', e.message)));
    } else if (logQueue.length) {
      scheduleLogFlush();
    }
  }
}

async function recordCall(apiKeyId, path, ip, statusCode, ms, isQuota = 0) {
  try {
    if (apiKeyId && isQuota) await incrementQuotaUsage(apiKeyId);
    if (logQueue.length >= LOG_QUEUE_MAX) logQueue.shift();
    logQueue.push({ apiKeyId, path, ip, statusCode, ms, isQuota: isQuota ? 1 : 0 });
    if (logQueue.length >= LOG_FLUSH_BATCH) {
      flushCallLogs().catch((e) => console.warn('[flushCallLogs]', e.message));
    } else {
      scheduleLogFlush();
    }
  } catch (e) {
    console.warn('[recordCall]', e.message);
  }
}

async function getDailyUsage(apiKeyId) {
  const key = dailyQuotaKey(apiKeyId);
  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    if (cached != null) return Number(cached) || 0;
  } catch (_) {}

  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS total FROM api_call_logs WHERE api_key_id = ? AND is_quota = 1 AND created_at >= CURDATE()',
    [apiKeyId]
  );
  const total = Number(row.total || 0);
  try {
    await getRedis().setex(key, secondsUntilTomorrow(), String(total));
  } catch (_) {}
  return total;
}

async function updateApiKey(id, payload) {
  const map = {
    name: 'name',
    dailyLimit: 'daily_limit',
    totalLimit: 'total_limit',
    ratePerMin: 'rate_per_min',
    maxResults: 'max_results',
    remark: 'remark',
    status: 'status'
  };
  const fields = [];
  const values = [];
  for (const k of Object.keys(map)) {
    if (payload[k] !== undefined) {
      let v = payload[k];
      if (['dailyLimit', 'totalLimit', 'ratePerMin', 'status'].includes(k)) v = Number(v) || 0;
      if (k === 'maxResults') v = Math.max(1, Math.min(10000, Number(v) || 1000));
      fields.push(`${map[k]} = ?`);
      values.push(v);
    }
  }
  if (payload.allowedSourceIds !== undefined) {
    const allowedStr = stringifyAllowedSourceIds(parseAllowedSourceIds(payload.allowedSourceIds));
    fields.push('allowed_source_ids = ?');
    values.push(allowedStr);
  }
  if (fields.length === 0) {
    const [rows] = await pool.query('SELECT * FROM api_keys WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }
  values.push(id);
  await pool.query(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`, values);
  await invalidateApiKeyCache(id);
  const [rows] = await pool.query('SELECT * FROM api_keys WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

function getAllowedSourceIdsOf(apiKey) {
  if (!apiKey) return null;
  return parseAllowedSourceIds(apiKey.allowed_source_ids);
}

module.exports = {
  createApiKey,
  updateApiKey,
  extendExpire,
  listApiKeys,
  verifyPlainKey,
  disableApiKey,
  enableApiKey,
  deleteApiKey,
  recordCall,
  getDailyUsage,
  flushCallLogs,
  getAllowedSourceIdsOf
};
