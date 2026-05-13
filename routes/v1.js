const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { apiKeyRequired } = require('../middleware/apiKeyAuth');
const { searchResources, getResource } = require('../services/resourceService');
const { resolve: resolveLink } = require('../services/linkResolver');
const { getDailyUsage } = require('../services/apiKeyService');

const router = express.Router();

router.use(apiKeyRequired);

router.get('/search', asyncHandler(async (req, res) => {
  const { q = '', page = 1, pageSize = 20, source_id } = req.query;
  const data = await searchResources({
    q, page, pageSize, sourceId: source_id || null
  });
  res.json({
    code: 200,
    message: 'ok',
    total: data.total,
    page: data.page,
    page_size: data.pageSize,
    items: data.items.map((r) => ({
      id: r.id,
      source_id: r.source_id,
      source: r.source_title,
      provider: r.source_provider,
      file_id: r.file_id,
      file_name: r.file_name,
      file_size: r.file_size,
      file_type: r.file_type,
      file_time: r.file_time,
      has_share_url: !!r.share_url
    }))
  });
}));

router.get('/resources/:id', asyncHandler(async (req, res) => {
  const r = await getResource(Number(req.params.id));
  if (!r || r.is_deleted) return res.status(404).json({ code: 404, message: '资源不存在' });
  res.json({
    code: 200,
    message: 'ok',
    item: {
      id: r.id,
      source_id: r.source_id,
      source: r.source_title,
      provider: r.source_provider,
      file_id: r.file_id,
      file_name: r.file_name,
      file_size: r.file_size,
      file_type: r.file_type,
      file_time: r.file_time,
      share_url: r.share_url || '',
      has_password: !!r.share_pwd
    }
  });
}));

router.get('/resources/:id/link', asyncHandler(async (req, res) => {
  const r = await getResource(Number(req.params.id));
  if (!r || r.is_deleted) return res.status(404).json({ code: 404, message: '资源不存在' });
  try {
    const { url, expire_at, cached } = await resolveLink(r);
    const quota = {};
    if (req.apiKey && req.apiKey.daily_limit > 0) {
      const used = await getDailyUsage(req.apiKey.id);
      quota.daily_limit = req.apiKey.daily_limit;
      quota.used_today = used;
      quota.remaining_today = Math.max(req.apiKey.daily_limit - used, 0);
    }
    res.json({
      code: 200,
      message: 'ok',
      file_name: r.file_name,
      file_size: r.file_size,
      url,
      expire_at,
      cached,
      ...quota
    });
  } catch (err) {
    res.status(502).json({ code: 502, message: '解析直链失败', detail: err.message });
  }
}));

router.get('/me', asyncHandler(async (req, res) => {
  const key = req.apiKey;
  const used = await getDailyUsage(key.id);
  res.json({
    code: 200,
    message: 'ok',
    name: key.name,
    key_prefix: key.key_prefix,
    daily_limit: key.daily_limit,
    total_limit: key.total_limit,
    rate_per_min: key.rate_per_min,
    used_today: used,
    used_total: key.used_total,
    expire_at: key.expire_at
  });
}));

module.exports = router;
