require('dotenv').config();

const { pool } = require('../config/db');
const outbox = require('../services/searchIndexOutboxService');
const jobs = require('../services/searchIndexJobService');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function outboxLoop() {
  const batch = Math.max(10, Number(process.env.SEARCH_OUTBOX_BATCH || 500));
  const interval = Math.max(500, Number(process.env.SEARCH_OUTBOX_INTERVAL_MS || 5000));
  while (true) {
    try {
      const r = await outbox.processBatch(batch);
      if (r.processed || r.failed) {
        console.log(`[search-outbox] processed=${r.processed} failed=${r.failed}`);
      } else {
        await sleep(interval);
      }
    } catch (err) {
      console.error('[search-outbox] failed:', err.message || err);
      await sleep(interval);
    }
  }
}

async function jobLoop() {
  const interval = Math.max(1000, Number(process.env.SEARCH_JOB_INTERVAL_MS || 5000));
  while (true) {
    try {
      const r = await jobs.processNextJob();
      if (r.processed) {
        console.log(`[search-job] job=${r.job_id} processed=1`);
      } else {
        await sleep(interval);
      }
    } catch (err) {
      console.error('[search-job] failed:', err.message || err);
      await sleep(interval);
    }
  }
}

Promise.all([outboxLoop(), jobLoop()])
  .catch((err) => {
    console.error('[search-worker] fatal:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
