const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { apiKeyRequired } = require('../middleware/apiKeyAuth');
const { searchResources, getResource } = require('../services/resourceService');
const { resolve: resolveLink } = require('../services/linkResolver');
const { getDailyUsage, getAllowedSourceIdsOf } = require('../services/apiKeyService');
const { formatFileSize } = require('../utils/fileSize');

const router = express.Router();

router.use(apiKeyRequired);

router.get('/search', asyncHandler(async (req, res) => {
  const { q = '', page = 1, pageSize = 20, source_id, cursor } = req.query;
  const allowed = getAllowedSourceIdsOf(req.apiKey);
  const cap = Math.max(1, Math.min(10000, Number(req.apiKey.max_results) || 1000));
  const data = await searchResources({
    q, page, pageSize, cursor,
    sourceId: source_id || null,
    allowedSourceIds: allowed,
    cap
  });
  res.json({
    code: 200,
    message: 'ok',
    total: data.total,
    page: data.page,
    page_size: data.pageSize,
    capped: !!data.capped,
    cap_limit: data.cap_limit || cap,
    next_cursor: data.next_cursor || null,
    has_more: !!data.has_more,
    items: data.items.map((r) => ({
      id: r.id,
      source_id: r.source_id,
      source: r.source_title,
      provider: r.source_provider,
      file_id: r.file_id,
      file_name: r.file_name,
      file_size: r.file_size,
      file_size_human: formatFileSize(r.file_size),
      file_type: r.file_type,
      file_time: r.file_time,
      has_share_url: !!r.share_url
    }))
  });
}));

// 把 source_id 是否在 key 白名单内的检查抽出来，多处复用
function checkSourceAllowed(req, sourceId) {
  const allowed = getAllowedSourceIdsOf(req.apiKey);
  if (!allowed) return true;
  return allowed.includes(Number(sourceId));
}

router.get('/resources/:id', asyncHandler(async (req, res) => {
  const r = await getResource(Number(req.params.id));
  if (!r || r.is_deleted) return res.status(404).json({ code: 404, message: '资源不存在' });
  if (!checkSourceAllowed(req, r.source_id)) {
    return res.status(403).json({ code: 403, message: '该资源所属库不在 API Key 授权范围内' });
  }
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
      file_size_human: formatFileSize(r.file_size),
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
  if (!checkSourceAllowed(req, r.source_id)) {
    return res.status(403).json({ code: 403, message: '该资源所属库不在 API Key 授权范围内' });
  }
  try {
    const { url, expire_at, cached } = await resolveLink(r);
    const quota = {};
    if (req.apiKey && req.apiKey.daily_limit > 0) {
      // /link 这一路才计配额。req.apiKeyDailyUsed 是中间件已经查过的"调用前"used
      // 真正写入 +1 在 res 'finish' 钩子里发生，所以这里给客户端一个最接近的预估
      const usedBefore = Number(req.apiKeyDailyUsed) || 0;
      const usedAfter = usedBefore + 1;
      quota.daily_limit = req.apiKey.daily_limit;
      quota.used_today = usedAfter;
      quota.remaining_today = Math.max(req.apiKey.daily_limit - usedAfter, 0);
    }
    res.json({
      code: 200,
      message: 'ok',
      file_name: r.file_name,
      file_size: r.file_size,
      file_size_human: formatFileSize(r.file_size),
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
  const allowed = getAllowedSourceIdsOf(key);
  res.json({
    code: 200,
    message: 'ok',
    name: key.name,
    key_prefix: key.key_prefix,
    daily_limit: key.daily_limit,
    total_limit: key.total_limit,
    rate_per_min: key.rate_per_min,
    max_results: key.max_results || 1000,
    allowed_source_ids: allowed, // null = 全部，数组 = 仅这几个
    quota_only_counts: 'GET /resources/:id/link', // 提示语：哪些路径才算配额
    used_today: used,
    used_total: key.used_total,
    expire_at: key.expire_at
  });
}));

module.exports = router;
