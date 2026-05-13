const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { pool } = require('../config/db');
const { jwtRequired, adminRequired } = require('../middleware/jwtAuth');
const { login, changePassword } = require('../services/userService');
const {
  listSources, getSource, saveSource, updateSource, deleteSource
} = require('../services/sourceService');
const { syncSource, checkSource, listSyncLogs, clearSyncLogs } = require('../services/lanzouSyncService');
const {
  searchResources, listResources, deleteResource
} = require('../services/resourceService');
const {
  createApiKey, listApiKeys, disableApiKey, enableApiKey, deleteApiKey
} = require('../services/apiKeyService');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await login(username, password);
  res.json({ code: 200, message: 'ok', ...result });
}));

router.use(jwtRequired);

router.get('/me', asyncHandler(async (req, res) => {
  res.json({ code: 200, user: req.user });
}));

router.post('/change-password', asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  await changePassword(req.user.id, oldPassword, newPassword);
  res.json({ code: 200, message: '修改成功' });
}));

// ---------- 仪表盘 ----------
router.get('/stats', asyncHandler(async (req, res) => {
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
  res.json({
    code: 200,
    users: Number(u.total),
    sources: Number(s.total),
    resources: Number(r.total),
    api_keys: Number(k.total),
    calls_24h: Number(c24.total),
    calls_today: Number(cToday.total)
  });
}));

router.get('/stats/call-trend', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total
       FROM api_call_logs
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
      GROUP BY day
      ORDER BY day ASC`
  );
  res.json({ code: 200, items: rows });
}));

// ---------- 资源管理 ----------
router.get('/resources', asyncHandler(async (req, res) => {
  const { q = '', page = 1, pageSize = 30, source_id } = req.query;
  const data = q
    ? await searchResources({ q, page, pageSize, sourceId: source_id || null })
    : await listResources({ page, pageSize, sourceId: source_id || null });
  res.json({ code: 200, ...data });
}));

router.delete('/resources/:id', adminRequired, asyncHandler(async (req, res) => {
  await deleteResource(Number(req.params.id));
  res.json({ code: 200, message: '已删除' });
}));

router.get('/resources/:id/link', asyncHandler(async (req, res) => {
  const { getResource } = require('../services/resourceService');
  const { resolve: resolveLink } = require('../services/linkResolver');
  const r = await getResource(Number(req.params.id));
  if (!r || r.is_deleted) return res.status(404).json({ code: 404, message: '资源不存在' });
  try {
    const { url, expire_at, cached } = await resolveLink(r);
    res.json({ code: 200, message: 'ok', file_name: r.file_name, url, expire_at, cached });
  } catch (err) {
    const ctx = {
      resource_id: r.id,
      source_provider: r.source_provider,
      source_login_type: r.source_login_type,
      file_id: r.file_id,
      has_share_url: !!r.share_url,
      has_share_pwd: !!r.share_pwd,
      has_account: !!r.source_account
    };
    res.status(502).json({
      code: 502,
      message: '解析直链失败',
      detail: (err && err.message) || String(err),
      context: ctx
    });
  }
}));

// ---------- 来源（蓝奏账号）管理 ----------
router.get('/sources', asyncHandler(async (req, res) => {
  const items = await listSources();
  res.json({ code: 200, items });
}));

router.post('/sources', adminRequired, asyncHandler(async (req, res) => {
  const item = await saveSource(req.body || {});
  res.json({ code: 200, message: '保存成功', item });
}));

router.patch('/sources/:id', adminRequired, asyncHandler(async (req, res) => {
  const item = await updateSource(Number(req.params.id), req.body || {});
  res.json({ code: 200, message: '更新成功', item });
}));

router.delete('/sources/:id', adminRequired, asyncHandler(async (req, res) => {
  await deleteSource(Number(req.params.id));
  res.json({ code: 200, message: '已删除' });
}));

router.post('/sources/:id/sync', adminRequired, asyncHandler(async (req, res) => {
  const result = await syncSource(Number(req.params.id));
  res.json({ code: 200, message: '同步完成', ...result });
}));

router.post('/sources/:id/check', adminRequired, asyncHandler(async (req, res) => {
  const result = await checkSource(Number(req.params.id));
  res.json({ code: 200, message: '检测完成', ...result });
}));

// ---------- 同步日志 ----------
router.get('/sync-logs', asyncHandler(async (req, res) => {
  const items = await listSyncLogs(Number(req.query.limit) || 100);
  res.json({ code: 200, items });
}));

router.delete('/sync-logs', adminRequired, asyncHandler(async (req, res) => {
  await clearSyncLogs();
  res.json({ code: 200, message: '已清空' });
}));

// ---------- API Key 管理 ----------
router.get('/api-keys', asyncHandler(async (req, res) => {
  const items = await listApiKeys();
  res.json({ code: 200, items });
}));

router.post('/api-keys', adminRequired, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const item = await createApiKey({
    name: body.name,
    dailyLimit: body.dailyLimit,
    totalLimit: body.totalLimit,
    ratePerMin: body.ratePerMin,
    remark: body.remark,
    expireAt: body.expireAt,
    ownerUserId: req.user.id
  });
  res.json({ code: 200, message: '创建成功', item });
}));

router.post('/api-keys/:id/disable', adminRequired, asyncHandler(async (req, res) => {
  await disableApiKey(Number(req.params.id));
  res.json({ code: 200, message: '已停用' });
}));

router.post('/api-keys/:id/enable', adminRequired, asyncHandler(async (req, res) => {
  await enableApiKey(Number(req.params.id));
  res.json({ code: 200, message: '已启用' });
}));

router.delete('/api-keys/:id', adminRequired, asyncHandler(async (req, res) => {
  await deleteApiKey(Number(req.params.id));
  res.json({ code: 200, message: '已删除' });
}));

// ---------- 调用日志 ----------
router.get('/call-logs', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const [rows] = await pool.query(
    `SELECT l.*, k.name AS key_name, k.key_prefix
       FROM api_call_logs l LEFT JOIN api_keys k ON k.id = l.api_key_id
      ORDER BY l.id DESC LIMIT ?`,
    [limit]
  );
  res.json({ code: 200, items: rows });
}));

module.exports = router;
