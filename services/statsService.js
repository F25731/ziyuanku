const { pool } = require('../config/db');
const { getRedis } = require('../config/redis');

const STATS_TTL = Math.max(10, Number(process.env.STATS_CACHE_TTL || 60));
const TREND_TTL = Math.max(30, Number(process.env.STATS_TREND_CACHE_TTL || 300));

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
    const [[r]] = await pool.query("SELECT COUNT(*) AS total FROM resources WHERE is_deleted=0");
    const [[k]] = await pool.query("SELECT COUNT(*) AS total FROM api_keys WHERE status=1");
    const [[c24]] = await pool.query(
      "SELECT COUNT(*) AS total FROM api_call_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)"
    );
    const [[cToday]] = await pool.query(
      "SELECT COUNT(*) AS total FROM api_call_logs WHERE created_at >= CURDATE()"
    );
    return {
      users: Number(u.total),
      sources: Number(s.total),
      resources: Number(r.total),
      api_keys: Number(k.total),
      calls_24h: Number(c24.total),
      calls_today: Number(cToday.total)
    };
  });
}

async function getCallTrend() {
  return cachedJson('stats:call_trend:14d:v1', TREND_TTL, async () => {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total
         FROM api_call_logs
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY day
        ORDER BY day ASC`
    );
    return rows;
  });
}

module.exports = { getDashboardStats, getCallTrend };
