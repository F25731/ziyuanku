const axios = require('axios');
const { pool } = require('../config/db');

const ENGINE = String(process.env.SEARCH_ENGINE || 'mysql').toLowerCase();
const BASE_URL = String(process.env.MEILI_URL || '').replace(/\/+$/, '');
const MASTER_KEY = process.env.MEILI_MASTER_KEY || '';
const INDEX = process.env.MEILI_INDEX || 'lrh_resources';
const TIMEOUT = Math.max(1000, Number(process.env.SEARCH_TIMEOUT_MS || 5000));
const BULK_BATCH = Math.max(100, Number(process.env.MEILI_BATCH_SIZE || 1000));
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.MEILI_RETRY_ATTEMPTS || 5));
const RETRY_BASE_MS = Math.max(100, Number(process.env.MEILI_RETRY_BASE_MS || 500));
const TASK_TIMEOUT_MS = Math.max(10000, Number(process.env.MEILI_TASK_TIMEOUT_MS || 120000));

let ensured = false;
let disabledUntil = 0;
let lastError = '';

function isEnabled() {
  return ENGINE === 'meilisearch' && !!BASE_URL;
}

function shouldSkip() {
  return !isEnabled() || Date.now() < disabledUntil;
}

function client() {
  const headers = {};
  if (MASTER_KEY) headers.Authorization = `Bearer ${MASTER_KEY}`;
  return axios.create({ baseURL: BASE_URL, timeout: TIMEOUT, headers });
}

function trimMessage(value, max = 1200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function formatError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.response) {
    parts.push(`status=${err.response.status}`);
    if (err.response.data) parts.push(`body=${trimMessage(err.response.data)}`);
  }
  return parts.join(' ');
}

function isRetryableError(err) {
  if (!err) return false;
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code)) return true;
  const status = err.response && Number(err.response.status);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coolDown(err, context = '') {
  disabledUntil = Date.now() + 15000;
  lastError = formatError(err);
  console.warn(`[meili] temporarily disabled${context ? ` ${context}` : ''}: ${lastError}`);
}

function getLastError() {
  return lastError;
}

function encodeCursor(offset) {
  const n = Math.max(0, Number(offset) || 0);
  return Buffer.from(JSON.stringify({ offset: n })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const s = String(cursor);
  if (/^\d+$/.test(s)) return Number(s);
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    const n = Number(parsed && parsed.offset);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function toDoc(row) {
  return {
    id: Number(row.id),
    file_name: row.file_name || '',
    source_id: Number(row.source_id),
    file_type: row.file_type || ''
  };
}

async function waitTask(taskUid) {
  if (taskUid == null) return;
  const c = client();
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data } = await c.get(`/tasks/${encodeURIComponent(String(taskUid))}`);
    if (data.status === 'succeeded') return;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(data.error && data.error.message || `Meilisearch task ${data.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Meilisearch task ${taskUid} timed out after ${TASK_TIMEOUT_MS}ms`);
}

async function postDocumentsWithRetry(c, docs) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await c.post(`/indexes/${encodeURIComponent(INDEX)}/documents`, docs);
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_ATTEMPTS || !isRetryableError(err)) throw err;
      const delay = RETRY_BASE_MS * attempt * attempt;
      console.warn(`[meili] retrying bulk index attempt=${attempt + 1}/${RETRY_ATTEMPTS} delay_ms=${delay}: ${formatError(err)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function ensureIndex() {
  if (ensured) return true;
  if (shouldSkip()) return false;
  const c = client();
  try {
    const exists = await c.get(`/indexes/${encodeURIComponent(INDEX)}`).then(() => true).catch((err) => {
      if (err.response && err.response.status === 404) return false;
      throw err;
    });
    if (!exists) {
      const { data } = await c.post('/indexes', { uid: INDEX, primaryKey: 'id' });
      await waitTask(data.taskUid);
    }
    const settingsTask = await c.patch(`/indexes/${encodeURIComponent(INDEX)}/settings`, {
      displayedAttributes: ['id', 'file_name', 'source_id', 'file_type'],
      searchableAttributes: ['file_name'],
      filterableAttributes: ['source_id', 'file_type'],
      sortableAttributes: ['id'],
      pagination: { maxTotalHits: Math.max(1000, Number(process.env.MEILI_MAX_TOTAL_HITS || 20000)) }
    });
    await waitTask(settingsTask.data && settingsTask.data.taskUid);
    ensured = true;
    return true;
  } catch (err) {
    coolDown(err, 'while ensuring index');
    return false;
  }
}

async function bulkIndexRows(rows) {
  if (!Array.isArray(rows) || !rows.length || shouldSkip()) return false;
  const ok = await ensureIndex();
  if (!ok) return false;
  const c = client();
  for (let i = 0; i < rows.length; i += BULK_BATCH) {
    const docs = rows.slice(i, i + BULK_BATCH)
      .filter((row) => !Number(row.is_deleted || 0))
      .map(toDoc)
      .filter((doc) => doc.id && doc.file_name);
    if (!docs.length) continue;
    try {
      const { data } = await postDocumentsWithRetry(c, docs);
      if (String(process.env.MEILI_WAIT_TASKS || '0') === '1') await waitTask(data.taskUid);
    } catch (err) {
      const firstId = docs[0] && docs[0].id;
      const lastId = docs[docs.length - 1] && docs[docs.length - 1].id;
      coolDown(err, `while indexing docs=${docs.length} first_id=${firstId} last_id=${lastId}`);
      return false;
    }
  }
  return true;
}

async function bulkIndexBySourceFileIds(sourceId, fileIds) {
  if (!isEnabled() || !Array.isArray(fileIds) || !fileIds.length) return false;
  const ids = Array.from(new Set(fileIds.map((x) => String(x || '').trim()).filter(Boolean)));
  if (!ids.length) return false;
  const [rows] = await pool.query(
    `SELECT id, source_id, file_name, file_type, is_deleted
       FROM resources
      WHERE source_id = ? AND file_id IN (?)`,
    [sourceId, ids]
  );
  return bulkIndexRows(rows);
}

async function deleteResource(id) {
  if (shouldSkip() || !id) return false;
  const ok = await ensureIndex();
  if (!ok) return false;
  try {
    await client().delete(`/indexes/${encodeURIComponent(INDEX)}/documents/${encodeURIComponent(String(id))}`);
    return true;
  } catch (err) {
    if (err.response && err.response.status === 404) return true;
    coolDown(err, `while deleting id=${id}`);
    return false;
  }
}

async function fetchResourcesByIds(ids) {
  const uniq = Array.from(new Set((ids || []).map(Number).filter(Boolean)));
  if (!uniq.length) return [];
  const [rows] = await pool.query(
    `SELECT r.id, r.source_id, r.file_id, r.file_name, r.file_size, r.file_type, r.file_time,
            r.share_url, r.share_pwd, r.created_at,
            s.title AS source_title, s.provider AS source_provider
       FROM resources r
       LEFT JOIN sources s ON s.id = r.source_id
      WHERE r.is_deleted = 0 AND r.id IN (?)`,
    [uniq]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return uniq.map((id) => byId.get(id)).filter(Boolean);
}

function buildFilter({ sourceId, allowedSourceIds }) {
  const parts = [];
  if (sourceId) {
    const sid = Number(sourceId);
    if (Array.isArray(allowedSourceIds) && allowedSourceIds.length > 0 && !allowedSourceIds.includes(sid)) {
      return { blocked: true, filter: '' };
    }
    parts.push(`source_id = ${sid}`);
  } else if (Array.isArray(allowedSourceIds) && allowedSourceIds.length > 0) {
    parts.push(`source_id IN [${allowedSourceIds.map(Number).filter(Boolean).join(',')}]`);
  }
  return { blocked: false, filter: parts.join(' AND ') };
}

async function searchResources({ q = '', page = 1, pageSize = 20, sourceId = null, allowedSourceIds = null, cap = 0, cursor = null, skipTotal = false }) {
  if (shouldSkip()) return null;
  q = String(q || '').trim();
  if (!q) return null;
  const ok = await ensureIndex();
  if (!ok) return null;

  const { blocked, filter } = buildFilter({ sourceId, allowedSourceIds });
  const capN = Math.max(0, Number(cap) || 0);
  if (blocked) {
    return {
      total: 0,
      items: [],
      capped: false,
      cap_limit: capN,
      processing_ms: 0,
      engine: 'meilisearch_scope_block',
      next_cursor: null,
      has_more: false
    };
  }

  const requestedSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const decodedOffset = decodeCursor(cursor);
  const offset = decodedOffset == null ? (Math.max(1, Number(page) || 1) - 1) * requestedSize : decodedOffset;
  if (capN > 0 && offset >= capN) {
    return {
      total: skipTotal ? null : capN,
      items: [],
      capped: true,
      cap_limit: capN,
      processing_ms: 0,
      engine: 'meilisearch',
      next_cursor: null,
      has_more: false
    };
  }

  const limit = capN > 0 ? Math.min(requestedSize + 1, capN - offset + 1) : requestedSize + 1;
  const body = {
    q,
    limit,
    offset,
    attributesToRetrieve: ['id'],
    showMatchesPosition: false
  };
  if (filter) body.filter = filter;

  const t0 = Date.now();
  try {
    const { data } = await client().post(`/indexes/${encodeURIComponent(INDEX)}/search`, body);
    const hits = Array.isArray(data.hits) ? data.hits : [];
    const hasMore = hits.length > requestedSize;
    const visibleHits = hasMore ? hits.slice(0, requestedSize) : hits;
    const ids = visibleHits.map((h) => Number(h.id)).filter(Boolean);
    const items = await fetchResourcesByIds(ids);
    const rawTotal = Number(data.estimatedTotalHits || data.totalHits || 0);
    const total = skipTotal ? null : (capN > 0 ? Math.min(rawTotal, capN) : rawTotal);
    const capped = !!(capN > 0 && rawTotal > capN);
    const nextOffset = offset + visibleHits.length;

    return {
      total,
      items,
      capped,
      cap_limit: capN,
      processing_ms: Date.now() - t0,
      engine: 'meilisearch',
      next_cursor: hasMore ? encodeCursor(nextOffset) : null,
      has_more: hasMore
    };
  } catch (err) {
    coolDown(err, 'while searching');
    return null;
  }
}

module.exports = {
  isEnabled,
  ensureIndex,
  bulkIndexRows,
  bulkIndexBySourceFileIds,
  deleteResource,
  searchResources,
  getLastError
};
