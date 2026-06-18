require('dotenv').config();

const { pool } = require('../config/db');
const cleanup = require('../services/cleanupService');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const once = process.argv.includes('--once');
  const interval = Math.max(1000, Number(process.env.CLEANUP_WORKER_INTERVAL_MS || 5000));

  do {
    const r = await cleanup.processNextWorkerRun();
    if (r.processed) {
      console.log(`[cleanup-worker] run=${r.run_id} type=${r.type} failed=${r.failed ? 1 : 0}`);
    } else if (once) {
      break;
    } else {
      await sleep(interval);
    }
  } while (!once);
}

main()
  .catch((err) => {
    console.error('[cleanup-worker] failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
