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
  listRunEvents, getRun, subscribeRun
} = require('../services/lanzouSyncService');
const {
  searchResources, listResources, deleteResource
} = require('../services/resourceService');
const {
  createApiKey, updateApiKey, extendExpire, listApiKeys, disableApiKey, enableApiKey, deleteApiKey
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

router.get('/sync-runs/:id/events', asyncHandler(async (req, res) => {
  const sinceId = Number(req.query.since_id) || 0;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const events = await listRunEvents(Number(req.params.id), sinceId, limit);
  res.json({ code: 200, items: events });
}));

// SSE：实时事件流。前端用 EventSource 订阅
// 兼容浏览器 EventSource 不带自定义 header 的限制 → token 走 query string
router.get('/sync-runs/:id/stream', asyncHandler(async (req, res) => {
  // 浏览器 EventSource 不能带 Authorization header，从 query 取 token 自己验
  const token = req.query.token;
  if (!token) return res.status(401).json({ code: 401, message: '缺少 token' });
  const { verifyToken, getUserById } = require('../services/userService');
  let payload;
  try { payload = verifyToken(String(token)); } catch (_) {
    return res.status(401).json({ code: 401, message: 'token 无效' });
  }
  const user = payload && payload.sub ? await getUserById(payload.sub) : null;
  if (!user || user.status !== 1) {
    return res.status(401).json({ code: 401, message: '用户已失效' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ code: 403, message: '需要管理员权限' });
  }

  const runId = Number(req.params.id);
  const run = await getRun(runId);
  if (!run) return res.status(404).json({ code: 404, message: 'run 不存在' });

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  // last-event-id：浏览器自动重连时会在 header 里带；这里也支持 query
  const lastEventId = Number(req.query.since_id || req.headers['last-event-id'] || 0);

  // 1) 历史回放：从 sync_run_events 取
  const history = await listRunEvents(runId, lastEventId, 2000);
  for (const evt of history) {
    res.write(`id: ${evt.event_id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt)}\n\n`);
  }

  // 2) 内存订阅：跟当前进行中的 run 保持实时
  let cursor = history.length ? Number(history[history.length - 1].event_id) : lastEventId;
  const sub = subscribeRun(runId, cursor);
  for (const evt of sub.backlog) {
    if (Number(evt.event_id) > cursor) {
      res.write(`id: ${evt.event_id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt)}\n\n`);
      cursor = Number(evt.event_id);
    }
  }

  const onEvent = (evt) => {
    if (Number(evt.event_id) <= cursor) return;
    cursor = Number(evt.event_id);
    res.write(`id: ${evt.event_id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt)}\n\n`);
  };
  sub.emitter.on('event', onEvent);

  // 心跳防止代理超时
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25_000);

  const onClose = () => {
    clearInterval(heartbeat);
    sub.emitter.off('event', onEvent);
    try { res.end(); } catch (_) {}
  };
  req.on('close', onClose);
  sub.emitter.once('close', () => {
    // run 结束后保留连接 1s 让最后事件送达，再关
    setTimeout(onClose, 1000);
  });
  // 如果 run 已经在订阅时就关闭了，5s 后主动关
  if (sub.closed) setTimeout(onClose, 1000);
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

// ---------- Meilisearch 索引 ----------
const searchIndex = require('../services/searchIndex');

router.get('/search-index/stats', asyncHandler(async (req, res) => {
  const stats = await searchIndex.getStats();
  res.json({ code: 200, ...stats });
}));

router.post('/search-index/rebuild', adminRequired, asyncHandler(async (req, res) => {
  if (!searchIndex.isEnabled()) {
    return res.status(400).json({ code: 400, message: 'Meilisearch 未配置（MEILI_HOST 未设置）' });
  }
  await searchIndex.ensureIndex();
  const r = await searchIndex.rebuildFromDb();
  res.json({ code: 200, message: '重建完成', ...r });
}));

module.exports = router;
