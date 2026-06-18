const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { pool } = require('../config/db');
const { jwtRequired, adminRequired } = require('../middleware/jwtAuth');
const { login, changePassword } = require('../services/userService');
const {
  listSources, getSource, saveSource, updateSource, deleteSource, unlockSource
} = require('../services/sourceService');
const {
  syncSource, testConnection, listSyncLogs, clearSyncLogs, listSyncRuns,
  getRun, requestPause, getSyncStatus
} = require('../services/lanzouSyncService');
const {
  searchResources, deleteResource
} = require('../services/resourceService');
const {
  createApiKey, updateApiKey, extendExpire, listApiKeys, disableApiKey, enableApiKey, deleteApiKey
} = require('../services/apiKeyService');
const cleanupService = require('../services/cleanupService');
const statsService = require('../services/statsService');
const searchIndexJobService = require('../services/searchIndexJobService');

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
  const stats = await statsService.getDashboardStats();
  res.json({ code: 200, ...stats });
}));

router.get('/stats/call-trend', asyncHandler(async (req, res) => {
  const rows = await statsService.getCallTrend();
  res.json({ code: 200, items: rows });
}));

// ---------- 资源管理 ----------
router.get('/resources', asyncHandler(async (req, res) => {
  const { q = '', page = 1, pageSize = 30, source_id, cursor } = req.query;
  const data = q
    ? await searchResources({ q, page, pageSize, sourceId: source_id || null, cursor, skipTotal: true })
    : await searchResources({ q: '', page, pageSize, sourceId: source_id || null, cursor, skipTotal: true });
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

// ---------- Manticore search index ----------
router.get('/search/status', asyncHandler(async (req, res) => {
  const data = await searchIndexJobService.getStatus();
  res.json({ code: 200, ...data });
}));

router.post('/search/jobs', adminRequired, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const result = await searchIndexJobService.createJob({
    mode: body.mode,
    sourceId: body.sourceId,
    batchSize: body.batchSize,
    maxAttempts: body.maxAttempts
  });
  res.json({
    code: 200,
    message: result.already_running ? '已有索引任务正在运行' : '索引任务已启动',
    ...result
  });
}));

router.post('/search/jobs/:id/pause', adminRequired, asyncHandler(async (req, res) => {
  const job = await searchIndexJobService.pauseJob(Number(req.params.id));
  res.json({ code: 200, message: '已请求暂停', job });
}));

router.post('/search/jobs/:id/resume', adminRequired, asyncHandler(async (req, res) => {
  const result = await searchIndexJobService.resumeJob(Number(req.params.id));
  res.json({
    code: 200,
    message: result.already_running ? '已有索引任务正在运行' : '索引任务已继续',
    ...result
  });
}));

router.delete('/search/jobs/:id', adminRequired, asyncHandler(async (req, res) => {
  const result = await searchIndexJobService.deleteJob(Number(req.params.id));
  res.json({ code: 200, message: '索引任务历史已删除', ...result });
}));

router.delete('/search/jobs', adminRequired, asyncHandler(async (req, res) => {
  const result = await searchIndexJobService.clearJobs();
  res.json({ code: 200, message: '索引任务历史已清空', ...result });
}));

router.post('/search/outbox/retry-failed', adminRequired, asyncHandler(async (req, res) => {
  const result = await searchIndexJobService.retryFailedOutbox();
  res.json({ code: 200, message: '已重置失败队列', ...result });
}));

// ---------- 来源（蓝奏账号）管理 ----------
router.get('/sources', asyncHandler(async (req, res) => {
  const items = await listSources();
  res.json({ code: 200, items });
}));

// 给"签发/编辑 API Key"弹窗选库用：只回 id + title，不回密码相关字段
router.get('/sources-lite', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, title FROM sources WHERE status=1 ORDER BY id ASC'
  );
  res.json({ code: 200, items: rows });
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
  // 异步同步：立即创建 run、返回 run_id 给前端订阅 SSE，扫描在后台跑
  const mode = (req.body && req.body.mode === 'full') ? 'full' : 'incremental';
  const sourceId = Number(req.params.id);
  // 先返回，后台 fire-and-forget；任何错误都已经被 syncSource 内部记到 sync_runs/sync_run_events 里
  const promise = syncSource(sourceId, mode).catch((err) => {
    console.error('[admin] syncSource error', sourceId, err && err.message);
  });
  // 等 100ms 让 syncSource 把 run 建出来，再回 run_id 给前端
  await new Promise((r) => setTimeout(r, 150));
  const [rows] = await pool.query(
    "SELECT id FROM sync_runs WHERE source_id=? ORDER BY id DESC LIMIT 1",
    [sourceId]
  );
  void promise;
  res.json({ code: 200, message: '同步已启动', run_id: rows[0] ? rows[0].id : null, mode });
}));

router.post('/sources/:id/test', adminRequired, asyncHandler(async (req, res) => {
  const result = await testConnection(Number(req.params.id));
  res.json({ code: 200, message: '连接成功', ...result });
}));

// 旧路径兼容：/check → testConnection
router.post('/sources/:id/check', adminRequired, asyncHandler(async (req, res) => {
  const result = await testConnection(Number(req.params.id));
  res.json({ code: 200, message: '连接成功', ...result });
}));

router.post('/sources/:id/unlock-cooldown', adminRequired, asyncHandler(async (req, res) => {
  const result = await unlockSource(Number(req.params.id));
  res.json({ code: 200, message: '已解冻', ...result });
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

// ---------- 同步 Run（断点续扫元数据） ----------
router.get('/sync-runs', asyncHandler(async (req, res) => {
  const sourceId = req.query.source_id ? Number(req.query.source_id) : null;
  const items = await listSyncRuns(sourceId, Number(req.query.limit) || 30);
  res.json({ code: 200, items });
}));

router.get('/sync-runs/:id', asyncHandler(async (req, res) => {
  const run = await getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ code: 404, message: 'run 不存在' });
  res.json({ code: 200, item: run });
}));

router.post('/sync-runs/:id/pause', adminRequired, asyncHandler(async (req, res) => {
  const ok = requestPause(Number(req.params.id));
  if (!ok) return res.status(409).json({ code: 409, message: 'run 当前不在运行中（可能已结束或运行在另一个进程）' });
  res.json({ code: 200, message: '已发送暂停信号' });
}));

// 给前端进度卡常驻轮询用：单次返回该源的 run 状态 + 进度统计
router.get('/sources/:id/sync-status', asyncHandler(async (req, res) => {
  const status = await getSyncStatus(Number(req.params.id));
  res.json({ code: 200, ...status });
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
    maxResults: body.maxResults,
    allowedSourceIds: body.allowedSourceIds,
    expireDays: body.expireDays,
    remark: body.remark,
    ownerUserId: req.user.id
  });
  res.json({ code: 200, message: '创建成功', item });
}));

router.patch('/api-keys/:id', adminRequired, asyncHandler(async (req, res) => {
  const item = await updateApiKey(Number(req.params.id), req.body || {});
  if (!item) return res.status(404).json({ code: 404, message: 'Key 不存在' });
  res.json({ code: 200, message: '更新成功', item });
}));

router.post('/api-keys/:id/extend', adminRequired, asyncHandler(async (req, res) => {
  const days = Number((req.body || {}).days);
  const r = await extendExpire(Number(req.params.id), days);
  res.json({ code: 200, message: '延长成功', ...r });
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

// ---------- 数据清理（去重 + 格式过滤） ----------
router.get('/cleanup/rules', asyncHandler(async (req, res) => {
  const items = await cleanupService.listRules();
  res.json({ code: 200, items });
}));
router.get('/cleanup/rules/:id', asyncHandler(async (req, res) => {
  const item = await cleanupService.getRule(Number(req.params.id));
  if (!item) return res.status(404).json({ code: 404, message: '规则不存在' });
  res.json({ code: 200, item });
}));
router.post('/cleanup/rules', adminRequired, asyncHandler(async (req, res) => {
  const { name, description, config, enabled } = req.body || {};
  const item = await cleanupService.createRule({ name, description, config, enabled });
  res.json({ code: 200, message: '已创建', item });
}));
router.patch('/cleanup/rules/:id', adminRequired, asyncHandler(async (req, res) => {
  const item = await cleanupService.updateRule(Number(req.params.id), req.body || {});
  res.json({ code: 200, message: '已保存', item });
}));
router.delete('/cleanup/rules/:id', adminRequired, asyncHandler(async (req, res) => {
  await cleanupService.deleteRule(Number(req.params.id));
  res.json({ code: 200, message: '已删除' });
}));

// 启动一次清理：立即返回 run_id，真正的扫描在后台跑（避免 HTTP 超时）
router.post('/cleanup/run', adminRequired, asyncHandler(async (req, res) => {
  const { ruleId, scopeSourceIds, crossSource, dryRun, confirmOver } = req.body || {};
  if (!ruleId) return res.status(400).json({ code: 400, message: 'ruleId 必填' });
  const result = await cleanupService.startCleanup({
    ruleId: Number(ruleId),
    scopeSourceIds: Array.isArray(scopeSourceIds) ? scopeSourceIds : [],
    crossSource: !!crossSource,
    dryRun: dryRun !== false,
    confirmOver: !!confirmOver
  });
  res.json({ code: 200, message: result.already_running ? '已有任务在跑，已接管' : '已启动，正在后台扫描', ...result });
}));

// 全局设置（safe_ratio 等）
router.get('/cleanup/settings', asyncHandler(async (req, res) => {
  const item = await cleanupService.getSettings();
  res.json({ code: 200, item });
}));
router.post('/cleanup/settings', adminRequired, asyncHandler(async (req, res) => {
  const item = await cleanupService.updateSettings(req.body || {});
  res.json({ code: 200, message: '已保存', item });
}));

router.get('/cleanup/runs', asyncHandler(async (req, res) => {
  const items = await cleanupService.listRuns({ limit: req.query.limit });
  res.json({ code: 200, items });
}));
router.get('/cleanup/runs/latest', asyncHandler(async (req, res) => {
  const item = await cleanupService.getLatestRun();
  res.json({ code: 200, item });
}));
router.get('/cleanup/runs/:id', asyncHandler(async (req, res) => {
  const item = await cleanupService.getRun(Number(req.params.id));
  if (!item) return res.status(404).json({ code: 404, message: 'Run 不存在' });
  res.json({ code: 200, item });
}));
router.get('/cleanup/runs/:id/samples', asyncHandler(async (req, res) => {
  const items = await cleanupService.getRunSamples(Number(req.params.id), req.query.limit);
  res.json({ code: 200, items });
}));
router.post('/cleanup/runs/:id/pause', adminRequired, asyncHandler(async (req, res) => {
  const ok = cleanupService.requestPause(Number(req.params.id));
  if (!ok) return res.status(409).json({ code: 409, message: 'Run 不在运行中（可能已结束或不在本进程内）' });
  res.json({ code: 200, message: '已发送暂停信号' });
}));
router.post('/cleanup/runs/:id/resume', adminRequired, asyncHandler(async (req, res) => {
  const r = await cleanupService.resumeRun(Number(req.params.id));
  res.json({ code: 200, message: '已恢复', ...r });
}));
router.post('/cleanup/runs/:id/undo', adminRequired, asyncHandler(async (req, res) => {
  await cleanupService.undoRun(Number(req.params.id));
  res.json({ code: 200, message: '已撤销，被删行已恢复' });
}));

module.exports = router;
