require('dotenv').config();

const { pool } = require('../config/db');
const outbox = require('../services/searchIndexOutboxService');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const once = process.argv.includes('--once');
  const batch = Math.max(10, Number(process.argv[2] || process.env.SEARCH_OUTBOX_BATCH || 500));
  const interval = Math.max(500, Number(process.env.SEARCH_OUTBOX_INTERVAL_MS || 5000));

  do {
    const r = await outbox.processBatch(batch);
    console.log(`[search-outbox] processed=${r.processed} failed=${r.failed}`);
    if (once) break;
    if (!r.processed && !r.failed) await sleep(interval);
  } while (true);
}

main()
  .catch((err) => {
    console.error('[search-outbox] failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
