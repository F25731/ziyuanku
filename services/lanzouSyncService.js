const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { getSource } = require('./sourceService');
const { upsertResources } = require('./resourceService');
const HttpError = require('../utils/httpError');

function toSyncHash(item) {
  return crypto.createHash('md5')
    .update([item.file_id || '', item.file_name || '', item.share_url || ''].join('|'))
    .digest('hex');
}

async function createSyncLog(sourceId, status, message) {
  const [result] = await pool.query(
    'INSERT INTO sync_logs (source_id, status, message) VALUES (?, ?, ?)',
    [sourceId, status, message || '']
  );
  return result.insertId;
}

async function finishSyncLog(logId, status, message, total = 0) {
  await pool.query(
    'UPDATE sync_logs SET status = ?, message = ?, total = ?, finished_at = NOW() WHERE id = ?',
    [status, message || '', Number(total) || 0, logId]
  );
}

function runIlanzouScript(source) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'ilanzou_sync_sdk.js');
    const child = spawn('node', [scriptPath], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `同步脚本退出码 ${code}`));
      }
      try {
        const clean = String(stdout || '').trim();
        const jsonText = clean.slice(clean.indexOf('{'));
        const result = JSON.parse(jsonText);
        if (!result.ok) return reject(new Error(result.message || '同步失败'));
        resolve(result.files || []);
      } catch (err) {
        reject(new Error(`同步脚本输出无法解析: ${stdout}`));
      }
    });
    child.stdin.write(JSON.stringify({
      provider: source.provider,
      rootFolderId: source.root_folder_id,
      loginType: source.login_type,
      account: source.account,
      password: source.password_text,
      cookie: source.cookie_text
    }));
    child.stdin.end();
  });
}

async function syncSource(sourceId) {
  const source = await getSource(sourceId);
  if (!source) throw new HttpError(404, '来源不存在');
  if (source.provider !== 'ilanzou' || source.login_type !== 'account') {
    throw new HttpError(400, '目前仅支持 ilanzou 账号模式同步，其它类型请手动添加 share_url');
  }

  const logId = await createSyncLog(sourceId, 'running', '开始同步');
  try {
    const raw = await runIlanzouScript(source);
    const files = raw.map((f) => ({ ...f, sync_hash: toSyncHash(f) }));
    const result = await upsertResources(sourceId, files);
    await finishSyncLog(logId, 'success', `同步成功，共 ${files.length} 个文件`, files.length);
    return { total: files.length, ...result };
  } catch (err) {
    await finishSyncLog(logId, 'failed', err.message || String(err));
    throw err;
  }
}

async function checkSource(sourceId) {
  const source = await getSource(sourceId);
  if (!source) throw new HttpError(404, '来源不存在');
  const logId = await createSyncLog(sourceId, 'running', '开始检测');
  try {
    const files = await runIlanzouScript(source);
    await pool.query('UPDATE sources SET last_check_at = NOW() WHERE id = ?', [sourceId]);
    await finishSyncLog(logId, 'success', `检测成功，共 ${files.length} 个文件`, files.length);
    return { total: files.length };
  } catch (err) {
    await finishSyncLog(logId, 'failed', err.message || String(err));
    throw err;
  }
}

async function listSyncLogs(limit = 100) {
  const [rows] = await pool.query(
    'SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?',
    [Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

async function clearSyncLogs() {
  await pool.query('DELETE FROM sync_logs');
}

module.exports = { syncSource, checkSource, listSyncLogs, clearSyncLogs };
