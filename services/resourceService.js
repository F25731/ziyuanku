const { pool } = require('../config/db');

async function searchResources({ q = '', page = 1, pageSize = 20, sourceId = null }) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const where = ['r.is_deleted = 0'];
  const params = [];
  if (q && String(q).trim()) {
    where.push('r.file_name LIKE ?');
    params.push(`%${String(q).trim()}%`);
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

  const [rows] = await pool.query(
    `SELECT r.id, r.source_id, r.file_id, r.file_name, r.file_size, r.file_type, r.file_time,
            r.share_url, r.share_pwd, r.created_at,
            s.title AS source_title, s.provider AS source_provider
       FROM resources r
       LEFT JOIN sources s ON s.id = r.source_id
       ${whereSql}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return {
    total: Number(countRow.total || 0),
    page,
    pageSize,
    items: rows
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
    await pool.query(
      'UPDATE resources SET is_deleted = 1 WHERE source_id = ? AND is_deleted = 0',
      [sourceId]
    );
    return { inserted: 0, marked_deleted: 0 };
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

    await conn.query(
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

    const fileIds = files.map((f) => String(f.file_id || '')).filter(Boolean);
    if (fileIds.length > 0) {
      await conn.query(
        `UPDATE resources SET is_deleted = 1
          WHERE source_id = ? AND is_deleted = 0 AND file_id NOT IN (?)`,
        [sourceId, fileIds]
      );
    }

    await conn.query(
      'UPDATE sources SET last_sync_at = NOW(), last_check_at = NOW() WHERE id = ?',
      [sourceId]
    );
    await conn.commit();
    return { inserted: files.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function listResources({ page = 1, pageSize = 50, sourceId = null } = {}) {
  return searchResources({ q: '', page, pageSize, sourceId });
}

async function deleteResource(id) {
  await pool.query('DELETE FROM resources WHERE id = ?', [id]);
}

module.exports = { searchResources, getResource, upsertResources, listResources, deleteResource };
