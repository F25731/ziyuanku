const axios = require('axios');
const { pool } = require('../config/db');

const ENGINE = String(process.env.SEARCH_ENGINE || 'mysql').toLowerCase();
const BASE_URL = String(process.env.SEARCH_URL || '').replace(/\/+$/, '');
const INDEX = process.env.SEARCH_INDEX || 'lrh_resources';
const USERNAME = process.env.SEARCH_USERNAME || '';
const PASSWORD = process.env.SEARCH_PASSWORD || '';
const TIMEOUT = Math.max(1000, Number(process.env.SEARCH_TIMEOUT_MS || 5000));
const BULK_BATCH = Math.max(100, Number(process.env.SEARCH_BULK_BATCH || 1000));

let ensured = false;
let disabledUntil = 0;

function isEnabled() {
  return !!BASE_URL && ['opensearch', 'elasticsearch', 'elastic'].includes(ENGINE);
}

function shouldSkip() {
  return !isEnabled() || Date.now() < disabledUntil;
}

function client() {
  const cfg = { baseURL: BASE_URL, timeout: TIMEOUT };
  if (USERNAME || PASSWORD) cfg.auth = { username: USERNAME, password: PASSWORD };
  return axios.create(cfg);
}

function coolDown(err) {
  disabledUntil = Date.now() + 30000;
  console.warn('[searchIndex] temporarily disabled:', err && err.message || err);
}

function encodeCursor(sort) {
  if (!Array.isArray(sort)) return null;
  return Buffer.from(JSON.stringify(sort)).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const s = String(cursor);
  if (/^\d+$/.test(s)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function toDoc(row) {
  return {
    id: Number(row.id),
    source_id: Number(row.source_id),
    file_id: row.file_id || '',
    file_name: row.file_name || '',
    file_size: row.file_size || '',
    file_type: row.file_type || '',
    file_time: row.file_time || '',
    share_url: row.share_url || '',
    is_deleted: Number(row.is_deleted || 0) ? true : false,
    updated_at: row.updated_at || row.created_at || new Date().toISOString()
  };
}

async function ensureIndex() {
  if (ensured || shouldSkip()) return false;
  const c = client();
  try {
    const exists = await c.head(`/${encodeURIComponent(INDEX)}`).then(() => true).catch((err) => {
      if (err.response && err.response.status === 404) return false;
      throw err;
    });
    if (!exists) {
      await c.put(`/${encodeURIComponent(INDEX)}`, {
        settings: {
          index: {
            number_of_shards: Math.max(1, Number(process.env.SEARCH_SHARDS || 3)),
            number_of_replicas: Math.max(0, Number(process.env.SEARCH_REPLICAS || 0))
          },
          analysis: {
            tokenizer: {
              lrh_ngram_tokenizer: {
                type: 'ngram',
                min_gram: 2,
                max_gram: 3,
                token_chars: ['letter', 'digit']
              }
            },
            analyzer: {
              lrh_ngram: {
                type: 'custom',
                tokenizer: 'lrh_ngram_tokenizer',
                filter: ['lowercase']
              }
            }
          }
        },
        mappings: {
          properties: {
            id: { type: 'long' },
            source_id: { type: 'long' },
            file_id: { type: 'keyword' },
            file_name: {
              type: 'text',
              analyzer: 'lrh_ngram',
              search_analyzer: 'standard',
              fields: { keyword: { type: 'keyword', ignore_above: 512 } }
            },
            file_size: { type: 'keyword' },
            file_type: { type: 'keyword' },
            file_time: { type: 'keyword' },
            share_url: { type: 'keyword', index: false },
            is_deleted: { type: 'boolean' },
            updated_at: { type: 'date', ignore_malformed: true }
          }
        }
      });
    }
    ensured = true;
    return true;
  } catch (err) {
    coolDown(err);
    return false;
  }
}

async function bulkIndexRows(rows) {
  if (!Array.isArray(rows) || !rows.length || shouldSkip()) return false;
  const ok = await ensureIndex();
  if (!ok) return false;
  const c = client();
  for (let i = 0; i < rows.length; i += BULK_BATCH) {
    const part = rows.slice(i, i + BULK_BATCH);
    const lines = [];
    for (const row of part) {
      lines.push(JSON.stringify({ index: { _index: INDEX, _id: String(row.id) } }));
      lines.push(JSON.stringify(toDoc(row)));
    }
    try {
      const resp = await c.post('/_bulk', lines.join('\n') + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson' }
      });
      if (resp.data && resp.data.errors) {
        console.warn('[searchIndex] bulk completed with item errors');
      }
    } catch (err) {
      coolDown(err);
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
    `SELECT id, source_id, file_id, file_name, file_size, file_type, file_time, share_url, is_deleted, created_at, updated_at
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
    await client().delete(`/${encodeURIComponent(INDEX)}/_doc/${encodeURIComponent(String(id))}`, {
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404
    });
    return true;
  } catch (err) {
    coolDown(err);
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

async function searchResources({ q = '', pageSize = 20, sourceId = null, allowedSourceIds = null, cap = 0, cursor = null }) {
  if (shouldSkip()) return null;
  q = String(q || '').trim();
  if (!q) return null;
  const ok = await ensureIndex();
  if (!ok) return null;

  const filter = [{ term: { is_deleted: false } }];
  if (sourceId) filter.push({ term: { source_id: Number(sourceId) } });
  if (Array.isArray(allowedSourceIds) && allowedSourceIds.length > 0) {
    if (sourceId && !allowedSourceIds.includes(Number(sourceId))) {
      return {
        total: 0,
        items: [],
        capped: false,
        cap_limit: Number(cap) || 0,
        processing_ms: 0,
        engine: 'opensearch_scope_block',
        next_cursor: null,
        has_more: false
      };
    }
    filter.push({ terms: { source_id: allowedSourceIds.map(Number) } });
  }

  const searchAfter = decodeCursor(cursor);
  const trackTotalHits = searchAfter ? false : Math.max(1, Math.min(10000, Number(cap) || 1000)) + 1;
  const body = {
    size: Math.min(100, Math.max(1, Number(pageSize) || 20)),
    track_total_hits: trackTotalHits,
    query: {
      bool: {
        filter,
        must: [{
          match: {
            file_name: {
              query: q,
              operator: 'and'
            }
          }
        }]
      }
    },
    sort: [{ _score: 'desc' }, { id: 'desc' }]
  };
  if (searchAfter) body.search_after = searchAfter;

  const t0 = Date.now();
  try {
    const resp = await client().post(`/${encodeURIComponent(INDEX)}/_search`, body);
    const hits = resp.data && resp.data.hits ? resp.data.hits : {};
    const hitList = hits.hits || [];
    const ids = hitList.map((h) => Number(h._source && h._source.id)).filter(Boolean);
    const items = await fetchResourcesByIds(ids);
    let total = null;
    let capped = false;
    const totalObj = hits.total;
    if (!searchAfter && totalObj) {
      const raw = typeof totalObj === 'number' ? totalObj : Number(totalObj.value || 0);
      const capN = Math.max(0, Number(cap) || 0);
      total = capN > 0 ? Math.min(raw, capN) : raw;
      capped = !!(capN > 0 && raw > capN);
    }
    const last = hitList[hitList.length - 1];
    return {
      total,
      items,
      capped,
      cap_limit: Number(cap) || 0,
      processing_ms: Date.now() - t0,
      engine: 'opensearch',
      next_cursor: last ? encodeCursor(last.sort) : null,
      has_more: !!last
    };
  } catch (err) {
    coolDown(err);
    return null;
  }
}

module.exports = {
  isEnabled,
  ensureIndex,
  bulkIndexRows,
  bulkIndexBySourceFileIds,
  deleteResource,
  searchResources
};
