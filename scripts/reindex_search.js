require('dotenv').config();

const { pool } = require('../config/db');
const searchIndex = require('../services/searchIndexService');

async function main() {
  if (!searchIndex.isEnabled()) {
    throw new Error('SEARCH_ENGINE/SEARCH_URL not configured; set SEARCH_ENGINE=opensearch and SEARCH_URL first');
  }
  await searchIndex.ensureIndex();

  const batchSize = Math.max(100, Number(process.argv[2] || process.env.SEARCH_REINDEX_BATCH || 2000));
  let lastId = Number(process.env.SEARCH_REINDEX_FROM_ID || 0);
  let total = 0;
  const started = Date.now();

  while (true) {
    const [rows] = await pool.query(
      `SELECT id, source_id, file_id, file_name, file_size, file_type, file_time, share_url, is_deleted, created_at, updated_at
         FROM resources
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
      [lastId, batchSize]
    );
    if (!rows.length) break;
    await searchIndex.bulkIndexRows(rows);
    lastId = rows[rows.length - 1].id;
    total += rows.length;
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
