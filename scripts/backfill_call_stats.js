require('dotenv').config();

const { pool } = require('../config/db');

async function main() {
  const batchDays = Math.max(1, Number(process.argv[2] || 30));
  console.log(`[backfill-call-stats] aggregating last ${batchDays} days`);

  await pool.query(
    `INSERT INTO api_call_hourly_stats
       (hour_at, api_key_id, total_calls, quota_calls, ok_calls, error_calls, total_ms)
     SELECT
       STR_TO_DATE(DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00'), '%Y-%m-%d %H:%i:%s') AS hour_at,
       COALESCE(api_key_id, 0) AS api_key_id,
       COUNT(*) AS total_calls,
       SUM(CASE WHEN is_quota = 1 THEN 1 ELSE 0 END) AS quota_calls,
       SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS ok_calls,
       SUM(CASE WHEN status_code < 200 OR status_code >= 400 THEN 1 ELSE 0 END) AS error_calls,
       SUM(ms) AS total_ms
      FROM api_call_logs
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY hour_at, api_key_id
     ON DUPLICATE KEY UPDATE
       total_calls = VALUES(total_calls),
       quota_calls = VALUES(quota_calls),
       ok_calls = VALUES(ok_calls),
       error_calls = VALUES(error_calls),
       total_ms = VALUES(total_ms)`,
    [batchDays]
  );

  await pool.query(
    `INSERT INTO api_call_hourly_stats
       (hour_at, api_key_id, total_calls, quota_calls, ok_calls, error_calls, total_ms)
     SELECT
       STR_TO_DATE(DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00'), '%Y-%m-%d %H:%i:%s') AS hour_at,
       0 AS api_key_id,
       COUNT(*) AS total_calls,
       SUM(CASE WHEN is_quota = 1 THEN 1 ELSE 0 END) AS quota_calls,
       SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS ok_calls,
       SUM(CASE WHEN status_code < 200 OR status_code >= 400 THEN 1 ELSE 0 END) AS error_calls,
       SUM(ms) AS total_ms
      FROM api_call_logs
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY hour_at
     ON DUPLICATE KEY UPDATE
       total_calls = VALUES(total_calls),
       quota_calls = VALUES(quota_calls),
       ok_calls = VALUES(ok_calls),
       error_calls = VALUES(error_calls),
       total_ms = VALUES(total_ms)`,
    [batchDays]
  );

  console.log('[backfill-call-stats] done');
}

main()
  .catch((err) => {
    console.error('[backfill-call-stats] failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
