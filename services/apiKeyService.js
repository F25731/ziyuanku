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

async function createApiKey({ name, dailyLimit = 0, totalLimit = 0, ratePerMin = 60, remark = '', expireAt = null, ownerUserId = null }) {
  if (!name) throw new HttpError(400, '名称必填');
  const plain = generatePlainKey();
  const prefix = prefixOf(plain);
  const keyHash = await hashKey(plain);

  const [result] = await pool.query(
    `INSERT INTO api_keys (name, key_prefix, key_hash, owner_user_id, daily_limit, total_limit, rate_per_min, remark, expire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, prefix, keyHash, ownerUserId, Number(dailyLimit) || 0, Number(totalLimit) || 0, Number(ratePerMin) || 60, remark || null, expireAt || null]
  );
  const id = result.insertId;
  return {
    id,
    name,
    plain_key: plain,
    key_prefix: prefix,
    daily_limit: Number(dailyLimit) || 0,
    total_limit: Number(totalLimit) || 0,
    rate_per_min: Number(ratePerMin) || 60,
    expire_at: expireAt,
    remark,
    warning: '请妥善保存：完整 key 只会显示这一次'
  };
}

async function listApiKeys() {
  const [rows] = await pool.query(
    `SELECT id, name, key_prefix, owner_user_id, daily_limit, total_limit, rate_per_min,
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

async function recordCall(apiKeyId, path, ip, statusCode, ms) {
  try {
    await pool.query(
      'INSERT INTO api_call_logs (api_key_id, path, ip, status_code, ms) VALUES (?, ?, ?, ?, ?)',
      [apiKeyId || null, String(path || '').slice(0, 255), String(ip || '').slice(0, 64), Number(statusCode) || 0, Number(ms) || 0]
    );
    if (apiKeyId) {
      await pool.query(
        'UPDATE api_keys SET used_total = used_total + 1, last_used_at = NOW() WHERE id = ?',
        [apiKeyId]
      );
    }
  } catch (e) {
    console.warn('[recordCall]', e.message);
  }
}

async function getDailyUsage(apiKeyId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS total FROM api_call_logs WHERE api_key_id = ? AND created_at >= CURDATE()',
    [apiKeyId]
  );
  return Number(row.total || 0);
}

// 只允许改非敏感字段：key_prefix / key_hash 永远不动
async function updateApiKey(id, payload) {
  const map = {
    name: 'name',
    dailyLimit: 'daily_limit',
    totalLimit: 'total_limit',
    ratePerMin: 'rate_per_min',
    remark: 'remark',
    expireAt: 'expire_at',
    status: 'status'
  };
  const fields = [];
  const values = [];
  for (const k of Object.keys(map)) {
    if (payload[k] !== undefined) {
      let v = payload[k];
      if (['dailyLimit', 'totalLimit', 'ratePerMin', 'status'].includes(k)) v = Number(v) || 0;
      if (k === 'expireAt' && (v === '' || v === null)) v = null;
      fields.push(`${map[k]} = ?`);
      values.push(v);
    }
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

module.exports = {
  createApiKey,
  updateApiKey,
  listApiKeys,
  verifyPlainKey,
  disableApiKey,
  enableApiKey,
  deleteApiKey,
  recordCall,
  getDailyUsage
};
