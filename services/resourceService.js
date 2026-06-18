const { pool } = require('../config/db');
const searchIndex = require('./searchIndexService');
const searchOutbox = require('./searchIndexOutboxService');
const searchCache = require('./searchCacheService');
const HttpError = require('../utils/httpError');
const { parseFileSizeToBytes, getFileExt } = require('../utils/resourceMeta');

const SEARCH_REQUIRE_EXTERNAL = String(process.env.SEARCH_REQUIRE_EXTERNAL || '0') === '1';
const SEARCH_MIN_QUERY_LEN = Math.max(1, Number(process.env.SEARCH_MIN_QUERY_LEN || 2));
let resourceMetaColumnsPromise = null;

async function hasResourceMetaColumns() {
  if (!resourceMetaColumnsPromise) {
    resourceMetaColumnsPromise = pool.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'resources'
          AND COLUMN_NAME IN ('file_size_bytes', 'file_ext')`
    ).then(([rows]) => {
      const names = new Set(rows.map((r) => r.COLUMN_NAME));
      return names.has('file_size_bytes') && names.has('file_ext');
    }).catch(() => false);
  }
  return resourceMetaColumnsPromise;
}

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

async function searchResourcesRaw({ q = '', page = 1, pageSize = 20, sourceId = null, allowedSourceIds = null, cap = 0, cursor = null, skipTotal = false }) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const cursorId = Number(cursor) > 0 ? Number(cursor) : null;
  const useCursor = !!cursorId;
  const offset = useCursor ? 0 : (page - 1) * pageSize;
  q = String(q || '').trim();

  if (q && searchIndex.isEnabled()) {
    const indexed = await searchIndex.searchResources({ q, pageSize, sourceId, allowedSourceIds, cap, cursor, skipTotal });
    if (indexed) {
      return {
        total: indexed.total,
        page,
        pageSize,
        items: indexed.items,
        capped: indexed.capped,
        cap_limit: indexed.cap_limit,
        processing_ms: indexed.processing_ms,
        engine: indexed.engine,
        next_cursor: indexed.next_cursor,
        has_more: indexed.has_more
      };
    }
  }
  if (q && SEARCH_REQUIRE_EXTERNAL) {
    throw new HttpError(503, '搜索服务不可用，请稍后重试');
  }

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
  // 单源筛选（前端 source_id 参数）
  if (sourceId) {
    where.push('r.source_id = ?');
    params.push(Number(sourceId));
  }
  // API Key 维度的库白名单：只能搜这几个 source 的资源
  // 注意：如果 sourceId 也指定了，必须在白名单内才有效，否则强制空结果
  if (Array.isArray(allowedSourceIds) && allowedSourceIds.length > 0) {
    if (sourceId && !allowedSourceIds.includes(Number(sourceId))) {
      return {
        total: 0, page, pageSize, items: [],
        capped: false, cap_limit: Number(cap) || 0,
        processing_ms: 0, engine: 'mysql_scope_block',
        next_cursor: null, has_more: false
      };
    }
    where.push(`r.source_id IN (${allowedSourceIds.map(() => '?').join(',')})`);
    params.push(...allowedSourceIds);
  }
  if (useCursor) {
    where.push('r.id < ?');
    params.push(cursorId);
  }
  const whereSql = 'WHERE ' + where.join(' AND ');

  // cap > 0 时走"截顶 COUNT"：用子查询 LIMIT cap 包一层，最多 count 到 cap+1 行
  // 这样关键词命中 50w 也只走索引扫前 cap+1 条，COUNT 几十毫秒内回；
  // 真有更多结果时返回 capped=true 让前端能提示
  const capN = Math.max(0, Number(cap) || 0);
  let total;
  let capped = false;
  if (skipTotal || useCursor) {
    total = null;
  } else if (capN > 0) {
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT 1 FROM resources r ${whereSql} LIMIT ?
       ) AS sub`,
      [...params, capN + 1]
    );
    total = Number(countRow.total || 0);
    if (total > capN) { total = capN; capped = true; }
  } else {
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM resources r ${whereSql}`,
      params
    );
    total = Number(countRow.total || 0);
  }

  // 排序：有关键词时按 FULLTEXT 相关度，没关键词按 id DESC
  const orderSql = useFulltext
    ? (useCursor ? 'ORDER BY r.id DESC' : 'ORDER BY MATCH(r.file_name) AGAINST(? IN BOOLEAN MODE) DESC, r.id DESC')
    : 'ORDER BY r.id DESC';
  const orderParams = useFulltext && !useCursor ? [params[0]] : [];

  // 分页超过 cap 时直接返回空（前端不该翻到那里，也别让 OFFSET 浪费 IO）
  if (!useCursor && capN > 0 && offset >= capN) {
    return {
      total, page, pageSize, items: [],
      capped, cap_limit: capN,
      processing_ms: 0, engine: useFulltext ? 'mysql_fulltext' : 'mysql_like',
      next_cursor: null, has_more: false
    };
  }
  // pageSize 不能跨过 cap 边界
  const effectiveLimit = capN > 0 ? Math.min(pageSize, capN - offset) : pageSize;

  const t0 = Date.now();
  const fetchLimit = (skipTotal || useCursor) ? effectiveLimit + 1 : effectiveLimit;
  const [rows] = await pool.query(
    `SELECT r.id, r.source_id, r.file_id, r.file_name, r.file_size, r.file_type, r.file_time,
            r.share_url, r.share_pwd, r.created_at,
            s.title AS source_title, s.provider AS source_provider
       FROM resources r
       LEFT JOIN sources s ON s.id = r.source_id
       ${whereSql}
       ${orderSql}
      LIMIT ? OFFSET ?`,
    [...params, ...orderParams, fetchLimit, offset]
  );
  const tookMs = Date.now() - t0;
  const hasMore = rows.length > effectiveLimit;
  const items = hasMore ? rows.slice(0, effectiveLimit) : rows;
  const nextCursor = hasMore && items.length ? items[items.length - 1].id : null;

  return {
    total,
    page,
    pageSize,
    items,
    capped,
    cap_limit: capN,
    processing_ms: tookMs,
    engine: useFulltext ? (useCursor ? 'mysql_fulltext_cursor' : 'mysql_fulltext') : (useCursor ? 'mysql_cursor' : 'mysql_like'),
    next_cursor: nextCursor,
    has_more: hasMore
  };
}

async function searchResources(options = {}) {
  const q = String(options.q || '').trim();
  if (q && Array.from(q).length < SEARCH_MIN_QUERY_LEN) {
    throw new HttpError(400, `关键词至少 ${SEARCH_MIN_QUERY_LEN} 个字符`);
  }

  const normalized = { ...options, q };
  const cached = await searchCache.get(normalized);
  if (cached) return cached;

  const data = await searchResourcesRaw(normalized);
  await searchCache.set(normalized, data);
  return data;
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
    const hasMetaColumns = await hasResourceMetaColumns();

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
    if (hasMetaColumns) {
      for (let i = 0; i < files.length; i++) {
        values[i].splice(5, 0, parseFileSizeToBytes(files[i].file_size));
        values[i].splice(7, 0, getFileExt(files[i].file_name || ''));
      }
    }

    const insertColumns = hasMetaColumns
      ? `source_id, parent_folder_id, file_id, file_name, file_size, file_size_bytes, file_type, file_ext, file_time,
          share_url, share_pwd, sync_hash, is_deleted`
      : `source_id, parent_folder_id, file_id, file_name, file_size, file_type, file_time,
          share_url, share_pwd, sync_hash, is_deleted`;
    const metaUpdates = hasMetaColumns
      ? `file_size_bytes = VALUES(file_size_bytes),
         file_ext = VALUES(file_ext),`
      : '';

    const [result] = await conn.query(
      `INSERT INTO resources
         (${insertColumns})
       VALUES ?
       ON DUPLICATE KEY UPDATE
         parent_folder_id = VALUES(parent_folder_id),
         file_name = VALUES(file_name),
         file_size = VALUES(file_size),
         file_type = VALUES(file_type),
         ${metaUpdates}
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
    // upsert 写完就能搜；外部索引通过 outbox 异步补齐。
    const fileIds = files.map((f) => f.file_id).filter(Boolean);
    searchOutbox.enqueueUpsertsBySourceFileIds(sourceId, fileIds).catch((e) => {
      console.warn('[searchOutbox] enqueue failed:', e.message);
    });
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
  let marked = 0;
  const batchSize = Math.max(100, Number(process.env.RECONCILE_DELETE_BATCH || 5000));
  while (true) {
    const [rows] = await pool.query(
      `SELECT id
         FROM resources
        WHERE source_id = ? AND is_deleted = 0
          AND (updated_at IS NULL OR updated_at < ?)
        ORDER BY id ASC
        LIMIT ?`,
      [sourceId, runStartedAt, batchSize]
    );
    if (!rows.length) break;
    const ids = rows.map((r) => r.id);
    const [r] = await pool.query(
      `UPDATE resources
          SET is_deleted = 1
        WHERE id IN (?) AND is_deleted = 0`,
      [ids]
    );
    marked += r.affectedRows || 0;
    searchOutbox.enqueueDeletes(ids).catch((e) => {
      console.warn('[searchOutbox] enqueue delete failed:', e.message);
    });
    if (rows.length < batchSize) break;
  }
  return { marked };
}

async function listResources({ page = 1, pageSize = 50, sourceId = null, allowedSourceIds = null, cap = 0 } = {}) {
  return searchResources({ q: '', page, pageSize, sourceId, allowedSourceIds, cap });
}

async function deleteResource(id) {
  await searchOutbox.enqueueDelete(id);
  await pool.query('DELETE FROM resources WHERE id = ?', [id]);
}

module.exports = { searchResources, getResource, upsertResources, reconcileDeletedAfterRun, listResources, deleteResource };
