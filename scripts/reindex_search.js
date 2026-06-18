require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const searchIndex = require('../services/searchIndexService');

const checkpointFile = process.env.SEARCH_REINDEX_CHECKPOINT_FILE
  || path.join(process.cwd(), 'logs', 'search-reindex-checkpoint.json');

function readCheckpoint() {
  if (!process.argv.includes('--resume')) return null;
  try {
    return JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCheckpoint(data) {
  try {
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    fs.writeFileSync(checkpointFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[reindex] checkpoint write failed:', err.message);
  }
}

async function main() {
  if (!searchIndex.isEnabled()) {
    throw new Error('Meilisearch is not configured; set SEARCH_ENGINE=meilisearch and MEILI_URL first');
  }
  const ready = await searchIndex.ensureIndex();
  if (!ready) {
    const reason = typeof searchIndex.getLastError === 'function' ? searchIndex.getLastError() : '';
    throw new Error(`Meilisearch index is not ready${reason ? `: ${reason}` : ''}`);
  }

  if (process.argv.includes('--reset')) {
    try { fs.unlinkSync(checkpointFile); } catch (_) {}
  }

  const checkpoint = readCheckpoint();
  const batchSize = Math.max(100, Number(process.argv[2] || process.env.SEARCH_REINDEX_BATCH || 2000));
  let lastId = Number(process.env.SEARCH_REINDEX_FROM_ID || (checkpoint && checkpoint.last_id) || 0);
  let total = Number((checkpoint && checkpoint.total) || 0);
  const started = Date.now();

  while (true) {
    const [rows] = await pool.query(
      `SELECT id, source_id, file_name, file_type, is_deleted
         FROM resources
        WHERE id > ? AND is_deleted = 0
        ORDER BY id ASC
        LIMIT ?`,
      [lastId, batchSize]
    );
    if (!rows.length) break;
    const ok = await searchIndex.bulkIndexRows(rows);
    if (!ok) {
      const firstId = rows[0] && rows[0].id;
      const batchLastId = rows[rows.length - 1] && rows[rows.length - 1].id;
      const reason = typeof searchIndex.getLastError === 'function' ? searchIndex.getLastError() : '';
      throw new Error(
        `bulk index returned false first_id=${firstId} last_id=${batchLastId} rows=${rows.length}${reason ? `: ${reason}` : ''}`
      );
    }
    lastId = rows[rows.length - 1].id;
    total += rows.length;
    writeCheckpoint({ last_id: lastId, total, updated_at: new Date().toISOString() });
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    console.log(`[reindex] indexed=${total} last_id=${lastId} speed=${Math.round(total / seconds)}/s`);
  }

  console.log(`[reindex] done total=${total} last_id=${lastId}`);
}

main()
  .catch((err) => {
    console.error('[reindex] failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
