require('dotenv').config();

const { pool } = require('../config/db');
const { parseFileSizeToBytes, getFileExt } = require('../utils/resourceMeta');

async function main() {
  const batchSize = Math.max(100, Number(process.argv[2] || process.env.RESOURCE_META_BACKFILL_BATCH || 5000));
  let lastId = Number(process.env.RESOURCE_META_BACKFILL_FROM_ID || 0);
  let total = 0;

  while (true) {
    const [rows] = await pool.query(
      `SELECT id, file_name, file_size
         FROM resources
        WHERE id > ? AND (file_size_bytes IS NULL OR file_ext IS NULL)
        ORDER BY id ASC
        LIMIT ?`,
      [lastId, batchSize]
    );
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      await pool.query(
        'UPDATE resources SET file_size_bytes=?, file_ext=? WHERE id=?',
        [parseFileSizeToBytes(row.file_size), getFileExt(row.file_name), row.id]
      );
    }
    total += rows.length;
    console.log(`[resource-meta] updated=${total} last_id=${lastId}`);
  }

  console.log(`[resource-meta] done total=${total} last_id=${lastId}`);
}

main()
  .catch((err) => {
    console.error('[resource-meta] failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
