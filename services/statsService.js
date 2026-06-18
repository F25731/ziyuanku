const { pool } = require('../config/db');
const { getRedis } = require('../config/redis');

const STATS_TTL = Math.max(10, Number(process.env.STATS_CACHE_TTL || 60));
const TREND_TTL = Math.max(30, Number(process.env.STATS_TREND_CACHE_TTL || 300));
const RESOURCE_EXACT = String(process.env.STATS_RESOURCE_EXACT || '0') === '1';

async function cachedJson(key, ttl, loader) {
  try {
    const redis = getRedis();
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw);
    const value = await loader();
    await redis.setex(key, ttl, JSON.stringify(value));
    return value;
  } catch (_) {
    return loader();
  }
}

async function getDashboardStats() {
  return cachedJson('stats:dashboard:v1', STATS_TTL, async () => {
    const [[u]] = await pool.query("SELECT COUNT(*) AS total FROM users WHERE status=1");
    const [[s]] = await pool.query("SELECT COUNT(*) AS total FROM sources WHERE status=1");
    const resources = await getResourceCount();
    const [[k]] = await pool.query("SELECT COUNT(*) AS total FROM api_keys WHERE status=1");
    const [[c24]] = await pool.query(
      "SELECT COALESCE(SUM(total_calls), 0) AS total FROM api_call_hourly_stats WHERE api_key_id = 0 AND hour_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)"
    );
    const [[cToday]] = await pool.query(
      "SELECT COALESCE(SUM(total_calls), 0) AS total FROM api_call_hourly_stats WHERE api_key_id = 0 AND hour_at >= CURDATE()"
    );
    return {
      users: Number(u.total),
      sources: Number(s.total),
      resources,
      api_keys: Number(k.total),
      calls_24h: Number(c24.total),
      calls_today: Number(cToday.total)
    };
  });
}

async function getCallTrend() {
  return cachedJson('stats:call_trend:14d:v1', TREND_TTL, async () => {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(hour_at, '%Y-%m-%d') AS day, COALESCE(SUM(total_calls), 0) AS total
         FROM api_call_hourly_stats
        WHERE api_key_id = 0 AND hour_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY day
        ORDER BY day ASC`
    );
    return rows;
  });
}

async function getResourceCount() {
  if (RESOURCE_EXACT) {
    const [[r]] = await pool.query("SELECT COUNT(*) AS total FROM resources WHERE is_deleted=0");
    return Number(r.total);
  }
  const [[row]] = await pool.query(
    `SELECT TABLE_ROWS AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resources'
      LIMIT 1`
  );
  return Number(row && row.total) || 0;
}

module.exports = { getDashboardStats, getCallTrend };
