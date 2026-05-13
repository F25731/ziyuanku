const { pool } = require('../config/db');
const HttpError = require('../utils/httpError');

async function listSources() {
  const [rows] = await pool.query(
    `SELECT id, title, provider, login_type, root_folder_id, account,
            CASE WHEN password_text IS NULL OR password_text = '' THEN 0 ELSE 1 END AS has_password,
            CASE WHEN cookie_text IS NULL OR cookie_text = '' THEN 0 ELSE 1 END AS has_cookie,
            status, last_check_at, last_sync_at, remark, created_at, updated_at
       FROM sources ORDER BY id DESC`
  );
  return rows;
}

async function getSource(id) {
  const [rows] = await pool.query('SELECT * FROM sources WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function saveSource(payload) {
  const title = String(payload.title || '').trim();
  const provider = String(payload.provider || 'ilanzou').trim();
  const loginType = String(payload.loginType || '').trim();
  const rootFolderId = String(payload.rootFolderId || '0').trim();
  const account = payload.account ? String(payload.account).trim() : null;
  const passwordText = payload.passwordText ? String(payload.passwordText) : null;
  const cookieText = payload.cookieText ? String(payload.cookieText) : null;
  const remark = payload.remark ? String(payload.remark) : null;

  if (!title) throw new HttpError(400, '标题必填');
  if (!['account', 'cookie', 'public'].includes(loginType)) {
    throw new HttpError(400, 'loginType 必须是 account / cookie / public');
  }
  if (loginType === 'account' && (!account || !passwordText)) {
    throw new HttpError(400, '账号模式必须填写 account 和 passwordText');
  }
  if (loginType === 'cookie' && !cookieText) {
    throw new HttpError(400, 'cookie 模式必须填写 cookieText');
  }

  const [result] = await pool.query(
    `INSERT INTO sources (title, provider, login_type, root_folder_id, account, password_text, cookie_text, remark, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [title, provider, loginType, rootFolderId, account, passwordText, cookieText, remark]
  );
  return getSource(result.insertId);
}

async function updateSource(id, payload) {
  const fields = [];
  const values = [];
  const allowed = ['title', 'root_folder_id', 'account', 'password_text', 'cookie_text', 'remark', 'status'];
  const map = {
    title: 'title',
    rootFolderId: 'root_folder_id',
    account: 'account',
    passwordText: 'password_text',
    cookieText: 'cookie_text',
    remark: 'remark',
    status: 'status'
  };
  for (const k of Object.keys(map)) {
    if (payload[k] !== undefined) {
      fields.push(`${map[k]} = ?`);
      values.push(payload[k]);
    }
  }
  if (fields.length === 0) return getSource(id);
  values.push(id);
  await pool.query(`UPDATE sources SET ${fields.join(', ')} WHERE id = ?`, values);
  return getSource(id);
}

async function deleteSource(id) {
  await pool.query('DELETE FROM resources WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM sync_logs WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM sources WHERE id = ?', [id]);
}

module.exports = { listSources, getSource, saveSource, updateSource, deleteSource };
