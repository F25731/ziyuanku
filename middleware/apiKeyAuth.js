const { verifyPlainKey, recordCall, getDailyUsage } = require('../services/apiKeyService');
const { getRedis } = require('../config/redis');

function extractKey(req) {
  const h = req.headers['x-api-key'];
  if (h) return String(h).trim();
  if (req.query && req.query.api_key) return String(req.query.api_key).trim();
  return '';
}

async function rateLimit(apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const win = Math.floor(now / 60);
  const rkey = `rl:${apiKey.id}:${win}`;
  try {
    const r = getRedis();
    const n = await r.incr(rkey);
    if (n === 1) await r.expire(rkey, 65);
    const limit = Number(apiKey.rate_per_min || 60);
    if (limit > 0 && n > limit) return false;
    return true;
  } catch (_) {
    return true;
  }
}

async function apiKeyRequired(req, res, next) {
  const started = Date.now();
  const plain = extractKey(req);
  if (!plain) {
    return res.status(401).json({ code: 401, message: '缺少 X-Api-Key 头' });
  }
  const apiKey = await verifyPlainKey(plain);
  if (!apiKey) {
    return res.status(401).json({ code: 401, message: 'API Key 无效或已过期' });
  }
  if (apiKey.__exhausted) {
    return res.status(429).json({ code: 429, message: '总次数已用尽' });
  }
  if (apiKey.daily_limit > 0) {
    const used = await getDailyUsage(apiKey.id);
    if (used >= apiKey.daily_limit) {
      return res.status(429).json({ code: 429, message: '今日次数已用尽', daily_limit: apiKey.daily_limit, used_today: used });
    }
    req.apiKeyDailyUsed = used;
  }
  const ok = await rateLimit(apiKey);
  if (!ok) {
    return res.status(429).json({ code: 429, message: '请求过于频繁，请稍后再试' });
  }
  req.apiKey = apiKey;

  res.on('finish', () => {
    recordCall(apiKey.id, req.originalUrl || req.url, req.ip, res.statusCode, Date.now() - started).catch(() => {});
  });

  return next();
}

module.exports = { apiKeyRequired };
