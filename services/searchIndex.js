const { MeiliSearch } = require('meilisearch');

const INDEX = 'resources';
let client = null;
let configured = null;

function getClient() {
  if (configured === false) return null;
  if (client) return client;
  const host = process.env.MEILI_HOST;
  const apiKey = process.env.MEILI_KEY;
  if (!host) {
    configured = false;
    return null;
  }
  client = new MeiliSearch({ host, apiKey: apiKey || undefined });
  configured = true;
  return client;
}

function isEnabled() {
  return getClient() !== null;
}

async function ensureIndex() {
  const c = getClient();
  if (!c) return false;
  try {
    await c.getIndex(INDEX);
  } catch (_) {
    await c.createIndex(INDEX, { primaryKey: 'id' });
  }
  // 索引设置：能搜的字段 + 过滤字段 + 排序字段
  const idx = c.index(INDEX);
  await idx.updateSettings({
    searchableAttributes: ['file_name', 'file_type', 'source_title'],
    filterableAttributes: ['source_id', 'is_deleted', 'has_share_url', 'file_type'],
    sortableAttributes: ['id', 'file_size_kb'],
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness'
    ]
  });
  return true;
}

function toDoc(r) {
  // 把 file_size 转成数字（KB 数）方便排序，没法解析就 0
  const sizeRaw = String(r.file_size || '').trim();
  let kb = Number(sizeRaw);
  if (!isFinite(kb)) {
    const m = sizeRaw.match(/^([\d.]+)\s*([a-zA-Z]+)/);
    if (m) {
      const n = parseFloat(m[1]);
      const u = m[2].toUpperCase();
      const mult = u.startsWith('B') ? 1 / 1024
                 : u.startsWith('K') ? 1
                 : u.startsWith('M') ? 1024
                 : u.startsWith('G') ? 1024 * 1024
                 : u.startsWith('T') ? 1024 * 1024 * 1024
                 : 0;
      kb = n * mult;
    } else { kb = 0; }
  }
  return {
    id: Number(r.id),
    source_id: Number(r.source_id || 0),
    source_title: r.source_title || '',
    file_id: r.file_id || '',
    file_name: r.file_name || '',
    file_size: r.file_size || '',
    file_size_kb: Math.round(kb),
    file_type: r.file_type || '',
    file_time: r.file_time || '',
    has_share_url: !!r.share_url,
    is_deleted: r.is_deleted ? 1 : 0,
    created_at: r.created_at ? new Date(r.created_at).getTime() : 0
  };
}

async function upsert(rows) {
  const c = getClient();
  if (!c || !rows || !rows.length) return;
  const docs = rows.map(toDoc);
  await c.index(INDEX).addDocuments(docs);
}

async function deleteById(ids) {
  const c = getClient();
  if (!c || !ids || !ids.length) return;
  await c.index(INDEX).deleteDocuments(ids.map(Number));
}

async function search({ q, page = 1, pageSize = 20, sourceId = null }) {
  const c = getClient();
  if (!c) return null;
  const filter = ['is_deleted = 0'];
  if (sourceId) filter.push(`source_id = ${Number(sourceId)}`);
  const offset = (Math.max(1, Number(page) || 1) - 1) * (Number(pageSize) || 20);
  const r = await c.index(INDEX).search(q || '', {
    filter,
    offset,
    limit: Math.min(100, Math.max(1, Number(pageSize) || 20)),
    attributesToHighlight: ['file_name'],
    showRankingScore: false
  });
  return {
    total: r.estimatedTotalHits || r.totalHits || 0,
    page: Math.max(1, Number(page) || 1),
    pageSize: Number(pageSize) || 20,
    items: (r.hits || []).map(h => ({
      id: h.id,
      source_id: h.source_id,
      source_title: h.source_title,
      file_id: h.file_id,
      file_name: h.file_name,
      file_size: h.file_size,
      file_type: h.file_type,
      file_time: h.file_time,
      has_share_url: h.has_share_url,
      _formatted: h._formatted // Meili 高亮
    })),
    processing_ms: r.processingTimeMs || 0
  };
}

async function getStats() {
  const c = getClient();
  if (!c) return { enabled: false };
  try {
    const stats = await c.index(INDEX).getStats();
    return {
      enabled: true,
      number_of_documents: stats.numberOfDocuments,
      is_indexing: stats.isIndexing,
      field_distribution: stats.fieldDistribution
    };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}

async function rebuildFromDb() {
  const c = getClient();
  if (!c) throw new Error('Meilisearch 未配置');
  const { pool } = require('../config/db');
  await ensureIndex();
  // 清空并重新灌入
  try { await c.index(INDEX).deleteAllDocuments(); } catch (_) {}

  let offset = 0;
  const batch = 5000;
  let total = 0;
  while (true) {
    const [rows] = await pool.query(
      `SELECT r.id, r.source_id, r.file_id, r.file_name, r.file_size, r.file_type,
              r.file_time, r.share_url, r.is_deleted, r.created_at, s.title AS source_title
         FROM resources r LEFT JOIN sources s ON s.id = r.source_id
        WHERE r.is_deleted = 0
        ORDER BY r.id ASC
        LIMIT ? OFFSET ?`,
      [batch, offset]
    );
    if (!rows.length) break;
    await c.index(INDEX).addDocuments(rows.map(toDoc));
    total += rows.length;
    offset += batch;
    if (rows.length < batch) break;
  }
  return { total };
}

module.exports = {
  isEnabled, ensureIndex, upsert, deleteById, search, getStats, rebuildFromDb
};
