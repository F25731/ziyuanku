const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const HttpError = require('../utils/httpError');

function generatePlainKey() {
  // 32 字节随机 base64url，去掉填充
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

async function hashKey(plain) {
  return bcrypt.hash(String(plain), 8);
}

async function compareKey(plain, hash) {
  return bcrypt.compare(String(plain), hash);
}

// allowed_source_ids 在数据库里存逗号分隔字符串：null 或 '' = 不限
// 解析成数字数组（去重去 0）；写库时反向 join
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
    return { id, expire_at: null, message: '原 Key 永不过期，无需延长' };
  }
  const expMs = new Date(row.expire_at).getTime();
  if (expMs < now) {
    baseSql = `DATE_ADD(NOW(), INTERVAL ${n} DAY)`;
  } else {
    baseSql = `DATE_ADD(expire_at, INTERVAL ${n} DAY)`;
  }
  await pool.query(`UPDATE api_keys SET expire_at = ${baseSql} WHERE id = ?`, [id]);
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
  const prefix = prefixOf(plain);
  const row = await getByPrefix(prefix);
  if (!row) return null;
  const ok = await compareKey(plain, row.key_hash);
  if (!ok) return null;
  if (row.expire_at && new Date(row.expire_at).getTime() < Date.now()) return null;
  if (row.total_limit > 0 && row.used_total >= row.total_limit) {
    return { ...row, __exhausted: true };
  }
  return row;
}

async function disableApiKey(id) {
  await pool.query('UPDATE api_keys SET status = 0 WHERE id = ?', [id]);
}

async function enableApiKey(id) {
  await pool.query('UPDATE api_keys SET status = 1 WHERE id = ?', [id]);
}

async function deleteApiKey(id) {
  await pool.query('DELETE FROM api_keys WHERE id = ?', [id]);
}

// is_quota=1 的请求才会累加 used_total，并被 getDailyUsage 计数
// 对应"只有解析直链才消耗配额"的语义
async function recordCall(apiKeyId, path, ip, statusCode, ms, isQuota = 0) {
  try {
    await pool.query(
      'INSERT INTO api_call_logs (api_key_id, path, ip, status_code, ms, is_quota) VALUES (?, ?, ?, ?, ?, ?)',
      [apiKeyId || null, String(path || '').slice(0, 255), String(ip || '').slice(0, 64), Number(statusCode) || 0, Number(ms) || 0, isQuota ? 1 : 0]
    );
    if (apiKeyId && isQuota) {
      await pool.query(
        'UPDATE api_keys SET used_total = used_total + 1, last_used_at = NOW() WHERE id = ?',
        [apiKeyId]
      );
    } else if (apiKeyId) {
      // 非计费调用也更新 last_used_at，方便后台看活跃度，但不动 used_total
      await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [apiKeyId]);
    }
  } catch (e) {
    console.warn('[recordCall]', e.message);
  }
}

// 当日已消耗配额的次数（只数 is_quota=1 的，例如直链解析）
async function getDailyUsage(apiKeyId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS total FROM api_call_logs WHERE api_key_id = ? AND is_quota = 1 AND created_at >= CURDATE()',
    [apiKeyId]
  );
  return Number(row.total || 0);
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
  const [rows] = await pool.query('SELECT * FROM api_keys WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

// 把 api_keys.allowed_source_ids 字符串解析成数字数组；NULL/空 = null（表示不限）
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
  getAllowedSourceIdsOf
};
