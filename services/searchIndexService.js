const axios = require('axios');
const { pool } = require('../config/db');

const ENGINE = String(process.env.SEARCH_ENGINE || 'mysql').toLowerCase();
const BASE_URL = String(process.env.MEILI_HOST || process.env.MEILISEARCH_HOST || '').replace(/\/+$/, '');
const MASTER_KEY = process.env.MEILI_MASTER_KEY || process.env.MEILISEARCH_MASTER_KEY || '';
const INDEX = process.env.MEILI_INDEX || process.env.SEARCH_INDEX || 'lrh_resources';
const TIMEOUT = Math.max(1000, Number(process.env.SEARCH_TIMEOUT_MS || 30000));
const BULK_BATCH = Math.max(50, Number(process.env.MEILI_BATCH_SIZE || 500));
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.MEILI_RETRY_ATTEMPTS || 5));
const RETRY_BASE_MS = Math.max(100, Number(process.env.MEILI_RETRY_BASE_MS || 500));
const MAX_TOTAL_HITS = Math.max(1000, Number(process.env.MEILI_MAX_TOTAL_HITS || 20000));

let ensured = false;
let disabledUntil = 0;
let lastError = '';

function isEnabled() {
  return (ENGINE === 'meilisearch' || ENGINE === 'meili') && !!BASE_URL;
}

function shouldSkip() {
  return !isEnabled() || Date.now() < disabledUntil;
}

function headers(extra = {}) {
  return {
    ...(MASTER_KEY ? { Authorization: `Bearer ${MASTER_KEY}` } : {}),
    ...extra
  };
}

function client(timeout = TIMEOUT) {
  return axios.create({ baseURL: BASE_URL, timeout, headers: headers() });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code)) return true;
  const status = err.response && Number(err.response.status);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function coolDown(err, context = '') {
  disabledUntil = Date.now() + 15000;
  lastError = formatError(err);
  if (isRetryableError(err)) ensured = false;
  console.warn(`[meilisearch] temporarily disabled${context ? ` ${context}` : ''}: ${lastError}`);
}

function getLastError() {
  return lastError;
}

function safeIndexName(name = INDEX) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('invalid Meilisearch index name');
  return s;
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
    source_id: Number(row.source_id) || 0,
    file_type: row.file_type || ''
  };
}

async function request(config, timeout = TIMEOUT) {
  return client(timeout).request({
    ...config,
    headers: headers(config.headers || {})
  });
}

async function waitForTask(taskUid, timeoutMs = 90000) {
  if (taskUid == null) return true;
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 90000);
  let errText = '';
  while (Date.now() < deadline) {
    try {
      const { data } = await request({ method: 'GET', url: `/tasks/${taskUid}` });
      if (data.status === 'succeeded') return true;
      if (data.status === 'failed' || data.status === 'canceled') {
        lastError = trimMessage(data.error || data);
        return false;
      }
    } catch (err) {
      errText = formatError(err);
    }
    await sleep(500);
  }
  lastError = errText || `Meilisearch task ${taskUid} timed out`;
  return false;
}

async function waitUntilReady(timeoutMs = 60000) {
  if (!isEnabled()) return false;
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 60000);
  let errText = '';
  while (Date.now() < deadline) {
    try {
      const { data } = await request({ method: 'GET', url: '/health' });
      if (!data || data.status === 'available') {
        lastError = '';
        return true;
      }
    } catch (err) {
      errText = formatError(err);
    }
    await sleep(1000);
  }
  lastError = errText || 'Meilisearch is not ready';
  return false;
}

async function ensureIndex() {
  if (ensured) return true;
  if (shouldSkip()) return false;
  try {
    const index = safeIndexName();
    try {
      await request({ method: 'GET', url: `/indexes/${encodeURIComponent(index)}` });
    } catch (err) {
      if (!err.response || err.response.status !== 404) throw err;
      const { data } = await request({
        method: 'POST',
        url: '/indexes',
        data: { uid: index, primaryKey: 'id' }
      });
      await waitForTask(data.taskUid, 90000);
    }

    const { data } = await request({
      method: 'PATCH',
      url: `/indexes/${encodeURIComponent(index)}/settings`,
      data: {
        searchableAttributes: ['file_name'],
        displayedAttributes: ['id', 'file_name', 'source_id', 'file_type'],
        filterableAttributes: ['source_id', 'file_type'],
        sortableAttributes: ['id'],
        pagination: { maxTotalHits: MAX_TOTAL_HITS },
        typoTolerance: { enabled: true }
      }
    });
    await waitForTask(data.taskUid, 90000);

    ensured = true;
    lastError = '';
    return true;
  } catch (err) {
    coolDown(err, 'while ensuring index');
    return false;
  }
}

async function resetIndex() {
  if (shouldSkip()) return false;
  const index = safeIndexName();
  try {
    try {
      const { data } = await request({ method: 'DELETE', url: `/indexes/${encodeURIComponent(index)}` });
      await waitForTask(data.taskUid, 90000);
    } catch (err) {
      if (!err.response || err.response.status !== 404) throw err;
    }
    ensured = false;
    return ensureIndex();
  } catch (err) {
    coolDown(err, 'while resetting index');
    return false;
  }
}

async function withRetry(label, fn) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_ATTEMPTS || !isRetryableError(err)) throw err;
      const delay = RETRY_BASE_MS * attempt * attempt;
      console.warn(`[meilisearch] retrying ${label} attempt=${attempt + 1}/${RETRY_ATTEMPTS} delay_ms=${delay}: ${formatError(err)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function bulkIndexRows(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length || shouldSkip()) return false;
  const ok = await ensureIndex();
  if (!ok) return false;
  const index = safeIndexName();

  for (let i = 0; i < rows.length; i += BULK_BATCH) {
    const docs = rows.slice(i, i + BULK_BATCH)
      .filter((row) => !Number(row.is_deleted || 0))
      .map(toDoc)
      .filter((doc) => doc.id && doc.file_name);
    if (!docs.length) continue;

    try {
      const { data } = await withRetry('bulk index', () => request({
        method: 'POST',
        url: `/indexes/${encodeURIComponent(index)}/documents?primaryKey=id`,
        data: docs
      }, Math.max(TIMEOUT, 60000)));
      if (options.waitTasks !== false) {
        const taskOk = await waitForTask(data.taskUid, Math.max(TIMEOUT, 90000));
        if (!taskOk) throw new Error(lastError || `Meilisearch task ${data.taskUid} failed`);
      }
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
    const { data } = await request({
      method: 'DELETE',
      url: `/indexes/${encodeURIComponent(safeIndexName())}/documents/${Number(id)}`
    });
    await waitForTask(data.taskUid, 60000);
    return true;
  } catch (err) {
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
      return { blocked: true, filter: null };
    }
    parts.push(`source_id = ${sid}`);
  } else if (Array.isArray(allowedSourceIds) && allowedSourceIds.length > 0) {
    const ids = allowedSourceIds.map(Number).filter(Boolean);
    if (ids.length) parts.push(`source_id IN [${ids.join(', ')}]`);
  }
  return { blocked: false, filter: parts.length ? parts : null };
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
  const t0 = Date.now();
  try {
    const { data } = await request({
      method: 'POST',
      url: `/indexes/${encodeURIComponent(safeIndexName())}/search`,
      data: {
        q,
        offset,
        limit,
        filter,
        attributesToRetrieve: ['id'],
        showRankingScore: false
      }
    });

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

async function getDocCount() {
  try {
    const { data } = await request({ method: 'GET', url: `/indexes/${encodeURIComponent(safeIndexName())}/stats` });
    return Number(data.numberOfDocuments || 0);
  } catch (err) {
    return null;
  }
}

async function getTaskSummary() {
  try {
    const { data } = await request({ method: 'GET', url: '/tasks?limit=100&statuses=enqueued,processing' });
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      processing: results.filter((t) => t.status === 'processing').length,
      enqueued: results.filter((t) => t.status === 'enqueued').length
    };
  } catch (_) {
    return { processing: 0, enqueued: 0 };
  }
}

async function getOverview() {
  const config = getConfig();
  if (!config.enabled) {
    return { config, health: { ok: false, message: 'Meilisearch is not enabled' }, index: null };
  }
  const overview = { config, health: { ok: false }, index: null, tasks: null, task_summary: { processing: 0, enqueued: 0 } };
  try {
    const { data } = await request({ method: 'GET', url: '/health' });
    overview.health = { ok: !data || data.status === 'available', status: data && data.status || 'available' };
  } catch (err) {
    overview.health = { ok: false, error: formatError(err) };
    return overview;
  }
  const count = await getDocCount();
  overview.index = {
    numberOfDocuments: count == null ? 0 : count,
    isIndexing: false,
    fieldDistribution: count == null ? {} : { id: count, file_name: count, source_id: count, file_type: count }
  };
  overview.task_summary = await getTaskSummary();
  return overview;
}

function getConfig() {
  return {
    engine: ENGINE,
    enabled: isEnabled(),
    url: BASE_URL,
    index: INDEX,
    has_master_key: !!MASTER_KEY,
    batch_size: BULK_BATCH,
    retry_attempts: RETRY_ATTEMPTS,
    retry_base_ms: RETRY_BASE_MS,
    max_total_hits: MAX_TOTAL_HITS,
    disabled_until: disabledUntil,
    last_error: lastError
  };
}

module.exports = {
  isEnabled,
  ensureIndex,
  resetIndex,
  bulkIndexRows,
  bulkIndexBySourceFileIds,
  deleteResource,
  searchResources,
  getLastError,
  getConfig,
  getOverview,
  waitUntilReady
};
