const { pool } = require('../config/db');
const searchIndex = require('./searchIndex');

async function searchResources({ q = '', page = 1, pageSize = 20, sourceId = null }) {
  // 优先走 Meilisearch
  if (searchIndex.isEnabled()) {
    try {
      const r = await searchIndex.search({ q, page, pageSize, sourceId });
      if (r) {
        // 回表补 source_title（Meili 里已经有 source_title 就直接用）+ 格式对齐
        return {
          total: r.total,
          page: r.page,
          pageSize: r.pageSize,
          items: r.items.map(h => ({
            id: h.id,
            source_id: h.source_id,
            source_title: h.source_title,
            source_provider: 'ilanzou',
            file_id: h.file_id,
            file_name: h.file_name,
            file_size: h.file_size,
            file_type: h.file_type,
            file_time: h.file_time,
            share_url: h.has_share_url ? 'yes' : '',
            _highlight: h._formatted && h._formatted.file_name
          })),
          processing_ms: r.processing_ms,
          engine: 'meili'
        };
      }
    } catch (err) {
      console.warn('[search] meili 查询失败，降级到 MySQL LIKE:', err.message);
    }
  }
  return await searchByLike({ q, page, pageSize, sourceId });
}

async function searchByLike({ q = '', page = 1, pageSize = 20, sourceId = null }) {
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
    items: rows,
    engine: 'mysql'
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

    // 注意：以前这里有一段 "UPDATE ... WHERE file_id NOT IN (?)" 的逻辑——
    // 在流式批量 upsert 模式下，每批 200 条都会把表里**其余所有数据标 is_deleted=1**，
    // 上一批写入下一批就被标删，灾难。整个 sync_run 结束后由 reconcileDeletedAfterRun 统一处理。
    await conn.query(
      'UPDATE sources SET last_sync_at = NOW(), last_check_at = NOW() WHERE id = ?',
      [sourceId]
    );
    await conn.commit();

    // Meili 同步推送（**等待**完成再返回）：避免 setImmediate 在 1G 容器里
    // 堆积大量 fire-and-forget 任务把 heap 顶爆。代价是每批多 ~50ms-200ms 网络耗时。
    if (searchIndex.isEnabled()) {
      try {
        const fileIdsList = files.map((f) => String(f.file_id || '')).filter(Boolean);
        if (fileIdsList.length) {
          const placeholders = fileIdsList.map(() => '?').join(',');
          const [rows] = await pool.query(
            `SELECT r.id, r.source_id, r.file_id, r.file_name, r.file_size, r.file_type,
                    r.file_time, r.share_url, r.is_deleted, r.created_at, s.title AS source_title
               FROM resources r LEFT JOIN sources s ON s.id = r.source_id
              WHERE r.source_id = ? AND r.file_id IN (${placeholders})`,
            [sourceId, ...fileIdsList]
          );
          if (rows.length) await searchIndex.upsert(rows);
        }
      } catch (e) {
        console.warn('[search] meili 推送失败:', e.message);
      }
    }

    return { inserted: files.length };
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
  if (searchIndex.isEnabled()) {
    searchIndex.deleteById([id]).catch(e => console.warn('[search] delete failed:', e.message));
  }
}

module.exports = { searchResources, getResource, upsertResources, reconcileDeletedAfterRun, listResources, deleteResource };
