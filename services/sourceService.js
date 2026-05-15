const { pool } = require('../config/db');
const HttpError = require('../utils/httpError');
const { getHealth, clearCooldown } = require('./rateLimiter');

function accountKeyOf(source) {
  if (!source) return null;
  if (source.provider === 'ilanzou' && source.account) return 'ilanzou:' + source.account;
  return null;
}

async function listSources() {
  const [rows] = await pool.query(
    `SELECT id, title, provider, login_type, root_folder_id, max_index_depth, account,
            CASE WHEN password_text IS NULL OR password_text = '' THEN 0 ELSE 1 END AS has_password,
            CASE WHEN cookie_text IS NULL OR cookie_text = '' THEN 0 ELSE 1 END AS has_cookie,
            status, last_check_at, last_sync_at, remark, created_at, updated_at
       FROM sources ORDER BY id DESC`
  );
  // 并行查每个账号的健康状态（Redis 操作很快）
  const enriched = await Promise.all(rows.map(async (s) => {
    const key = accountKeyOf(s);
    const health = key ? await getHealth(key) : null;
    return { ...s, health };
  }));
  return enriched;
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
  const maxIndexDepth = Math.max(1, Math.min(100, Number(payload.maxIndexDepth) || 20));
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
    `INSERT INTO sources (title, provider, login_type, root_folder_id, max_index_depth, account, password_text, cookie_text, remark, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [title, provider, loginType, rootFolderId, maxIndexDepth, account, passwordText, cookieText, remark]
  );
  return getSource(result.insertId);
}

async function updateSource(id, payload) {
  const fields = [];
  const values = [];
  const map = {
    title: 'title',
    rootFolderId: 'root_folder_id',
    maxIndexDepth: 'max_index_depth',
    account: 'account',
    passwordText: 'password_text',
    cookieText: 'cookie_text',
    remark: 'remark',
    status: 'status'
  };
  for (const k of Object.keys(map)) {
    if (payload[k] !== undefined) {
      let v = payload[k];
      if (k === 'maxIndexDepth') v = Math.max(1, Math.min(100, Number(v) || 20));
      fields.push(`${map[k]} = ?`);
      values.push(v);
    }
  }
  if (fields.length === 0) return getSource(id);
  values.push(id);
  await pool.query(`UPDATE sources SET ${fields.join(', ')} WHERE id = ?`, values);
  return getSource(id);
}

async function deleteSource(id) {
  // 级联清理 sync_runs / sync_progress / sync_run_events / resources / sync_logs
  // 阶段5 之后：搜索完全靠 MySQL FULLTEXT，删 resources 即生效，不再需要同步删外部索引
  const { deleteRunsBySource } = require('./lanzouSyncService');
  await deleteRunsBySource(id);
  await pool.query('DELETE FROM resources WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM sync_logs WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM sources WHERE id = ?', [id]);
}

async function unlockSource(id) {
  const source = await getSource(id);
  if (!source) throw new HttpError(404, '来源不存在');
  const key = accountKeyOf(source);
  if (!key) throw new HttpError(400, '该来源没有可解冻的账号 key');
  await clearCooldown(key);
  return { accountKey: key };
}

module.exports = { listSources, getSource, saveSource, updateSource, deleteSource, unlockSource };
