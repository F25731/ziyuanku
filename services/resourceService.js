const { pool } = require('../config/db');

// 把用户输入的关键词转成 MySQL FULLTEXT BOOLEAN MODE 表达式
// 多个空白分隔的词都用 + 前缀强制 AND，并按 ngram 拆词后的"短语"包起来更稳
//   "蓝奏 资源" → "+蓝奏 +资源"
// MySQL 默认 ngram_token_size=2，单字符词需要至少 2 字符才参与匹配；为了兼容单字搜索（"奏"），
// 兜底再 OR 一个 LIKE。
function buildBooleanQuery(q) {
  const tokens = String(q || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  // 转义 BOOLEAN MODE 的特殊字符： + - > < ( ) ~ * " @
  const safe = tokens.map((t) => t.replace(/[+\-><()~*"@]/g, ' ').trim()).filter(Boolean);
  if (!safe.length) return null;
  return safe.map((t) => `+${t}*`).join(' '); // 每个词必须出现，前缀通配
}

async function searchResources({ q = '', page = 1, pageSize = 20, sourceId = null }) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (page - 1) * pageSize;
  q = String(q || '').trim();

  const where = ['r.is_deleted = 0'];
  const params = [];

  let useFulltext = false;
  if (q) {
    const boolQ = buildBooleanQuery(q);
    // 单字搜索（< ngram_token_size）走 LIKE 兜底，否则用 FULLTEXT
    if (boolQ && q.length >= 2) {
      where.push('MATCH(r.file_name) AGAINST(? IN BOOLEAN MODE)');
      params.push(boolQ);
      useFulltext = true;
    } else {
      where.push('r.file_name LIKE ?');
      params.push(`%${q}%`);
    }
  }
  if (sourceId) {
    where.push('r.source_id = ?');
    params.push(Number(sourceId));
  }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM resources r ${whereSql}`,
    params
  );
  const total = Number(countRow.total || 0);

  // 排序：有关键词时按 FULLTEXT 相关度，没关键词按 id DESC
  const orderSql = useFulltext
    ? 'ORDER BY MATCH(r.file_name) AGAINST(? IN BOOLEAN MODE) DESC, r.id DESC'
    : 'ORDER BY r.id DESC';
  const orderParams = useFulltext ? [params[0]] : [];

  const t0 = Date.now();
  const [rows] = await pool.query(
    `SELECT r.id, r.source_id, r.file_id, r.file_name, r.file_size, r.file_type, r.file_time,
            r.share_url, r.share_pwd, r.created_at,
            s.title AS source_title, s.provider AS source_provider
       FROM resources r
       LEFT JOIN sources s ON s.id = r.source_id
       ${whereSql}
       ${orderSql}
      LIMIT ? OFFSET ?`,
    [...params, ...orderParams, pageSize, offset]
  );
  const tookMs = Date.now() - t0;

  return {
    total,
    page,
    pageSize,
    items: rows,
    processing_ms: tookMs,
    engine: useFulltext ? 'mysql_fulltext' : 'mysql_like'
  };
}

async function getResource(id) {
  const [rows] = await pool.query(
    `SELECT r.*, s.title AS source_title, s.provider AS source_provider,
            s.account AS source_account, s.password_text AS source_password,
            s.cookie_text AS source_cookie, s.login_type AS source_login_type
       FROM resources r
       LEFT JOIN sources s ON s.id = r.source_id
      WHERE r.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function upsertResources(sourceId, files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { total: 0, inserted: 0, updated: 0 };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const values = files.map((f) => [
      sourceId,
      f.parent_folder_id || null,
      f.file_id || null,
      (f.file_name || '').slice(0, 500),
      f.file_size || '',
      f.file_type || '',
      f.file_time || '',
      f.share_url || null,
      f.share_pwd || null,
      f.sync_hash || null,
      0
    ]);

    const [result] = await conn.query(
      `INSERT INTO resources
         (source_id, parent_folder_id, file_id, file_name, file_size, file_type, file_time,
          share_url, share_pwd, sync_hash, is_deleted)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         parent_folder_id = VALUES(parent_folder_id),
         file_name = VALUES(file_name),
         file_size = VALUES(file_size),
         file_type = VALUES(file_type),
         file_time = VALUES(file_time),
         share_url = VALUES(share_url),
         share_pwd = VALUES(share_pwd),
         sync_hash = VALUES(sync_hash),
         is_deleted = 0`,
      [values]
    );

    // MySQL 多行 INSERT...ON DUPLICATE KEY 的 affectedRows 规则：
    //   每行新插入 +1，每行命中重复键且实际更新 +2，未改动 +0
    // 反推: inserted = 2*total - affectedRows, updated = affectedRows - total
    const total = files.length;
    const aff = Number(result.affectedRows) || 0;
    const inserted = Math.max(0, 2 * total - aff);
    const updated = Math.max(0, aff - total);

    // 注意：以前这里有一段 "UPDATE ... WHERE file_id NOT IN (?)" 的逻辑——
    // 在流式批量 upsert 模式下，每批 200 条都会把表里**其余所有数据标 is_deleted=1**，
    // 上一批写入下一批就被标删，灾难。整个 sync_run 结束后由 reconcileDeletedAfterRun 统一处理。
    await conn.query(
      'UPDATE sources SET last_sync_at = NOW(), last_check_at = NOW() WHERE id = ?',
      [sourceId]
    );
    await conn.commit();

    // 阶段5 之后：搜索完全靠 MySQL FULLTEXT 索引（005 migration 建好），
    // upsert 写完就能搜——不再需要异步双写到 Meilisearch
    return { total, inserted, updated };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// 在一个 sync_run 完整跑完后调用：把"本次 run 没碰过"的旧资源标 is_deleted=1
// 用 last_sync_at（一次 run 内 upsertResources 都会更新源 last_sync_at）作分界点。
// 比基于 sync_hash 或 file_id NOT IN 都更便宜：单条 UPDATE，靠时间戳索引
async function reconcileDeletedAfterRun(sourceId, runStartedAt) {
  if (!runStartedAt) return { marked: 0 };
  const [r] = await pool.query(
    `UPDATE resources
        SET is_deleted = 1
      WHERE source_id = ? AND is_deleted = 0
        AND (updated_at IS NULL OR updated_at < ?)`,
    [sourceId, runStartedAt]
  );
  return { marked: r.affectedRows || 0 };
}

async function listResources({ page = 1, pageSize = 50, sourceId = null } = {}) {
  return searchResources({ q: '', page, pageSize, sourceId });
}

async function deleteResource(id) {
  await pool.query('DELETE FROM resources WHERE id = ?', [id]);
}

module.exports = { searchResources, getResource, upsertResources, reconcileDeletedAfterRun, listResources, deleteResource };
