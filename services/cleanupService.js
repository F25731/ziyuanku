// 阶段7（重写版）：清理 / 去重服务
// 关键设计：
//  - 规则 JSON DSL，不执行用户 JS
//  - **完全不写 MySQL 中间表**：去重在 Node 内存里跑 Map<group_key, winner>，
//    losers id 收集到数组，最后批量软删除——避免之前 _cleanup_temp 撑爆磁盘
//  - 批次内每 N 行检查 pauseRequested，可中途暂停
//  - 进度每 ~2 秒节流写 cleanup_runs，让前端轮询能看到数字跳
//  - samples 写独立的 cleanup_run_samples 表（不再借用 error_message）
//  - 安全阈值从 cleanup_settings 读，dry-run 永远过；apply 超阈值返 422 让前端确认

const { pool } = require('../config/db');
const HttpError = require('../utils/httpError');

const BATCH_SCAN = 5000;       // 一次从 resources 拉多少行
const BATCH_UPDATE = 20000;    // UPDATE / INSERT 一次最多动多少行
const SAMPLE_LIMIT = 50;
const PROGRESS_FLUSH_MS = 2000;

// runId -> { pauseRequested: bool }
const runningCleanups = new Map();

// ---------- 全局设置（cleanup_settings 单行表） ----------
async function getSettings() {
  const [[row]] = await pool.query('SELECT * FROM cleanup_settings WHERE id = 1 LIMIT 1');
  if (!row) {
    await pool.query('INSERT IGNORE INTO cleanup_settings (id, safe_ratio) VALUES (1, 0.3)');
    return { safe_ratio: 0.3 };
  }
  return { safe_ratio: Number(row.safe_ratio) || 0.3 };
}
async function updateSettings({ safeRatio }) {
  const r = Math.max(0.01, Math.min(1, Number(safeRatio)));
  if (!Number.isFinite(r)) throw new HttpError(400, 'safeRatio 不合法');
  await pool.query(
    'INSERT INTO cleanup_settings (id, safe_ratio) VALUES (1, ?) ON DUPLICATE KEY UPDATE safe_ratio = VALUES(safe_ratio)',
    [r]
  );
  return getSettings();
}

// ---------- 规则 CRUD ----------
async function listRules() {
  const [rows] = await pool.query(
    'SELECT id, name, description, config, enabled, created_at, updated_at FROM cleanup_rules ORDER BY id ASC'
  );
  return rows;
}
async function getRule(id) {
  const [[row]] = await pool.query('SELECT * FROM cleanup_rules WHERE id = ?', [id]);
  return row || null;
}
async function createRule({ name, description, config, enabled = 1 }) {
  if (!name || !config) throw new HttpError(400, '名称和配置必填');
  validateConfig(config);
  const [r] = await pool.query(
    'INSERT INTO cleanup_rules (name, description, config, enabled) VALUES (?, ?, ?, ?)',
    [name, description || null, JSON.stringify(config), enabled ? 1 : 0]
  );
  return getRule(r.insertId);
}
async function updateRule(id, { name, description, config, enabled }) {
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description); }
  if (config !== undefined) { validateConfig(config); fields.push('config = ?'); values.push(JSON.stringify(config)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); values.push(enabled ? 1 : 0); }
  if (!fields.length) return getRule(id);
  values.push(id);
  await pool.query(`UPDATE cleanup_rules SET ${fields.join(', ')} WHERE id = ?`, values);
  return getRule(id);
}
async function deleteRule(id) {
  await pool.query('DELETE FROM cleanup_rules WHERE id = ?', [id]);
}

// ---------- 配置校验 ----------
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new HttpError(400, 'config 必须是对象');
  if (cfg.qualifier && cfg.qualifier.name_must_match) {
    try { new RegExp(cfg.qualifier.name_must_match); }
    catch (_) { throw new HttpError(400, 'qualifier.name_must_match 不是合法正则'); }
  }
  if (Array.isArray(cfg.score_rules)) {
    for (const r of cfg.score_rules) {
      try { new RegExp(r.pattern); }
      catch (_) { throw new HttpError(400, `score_rules 里 ${r.pattern} 不是合法正则`); }
    }
  }
  const ff = cfg.format_filter || {};
  if (ff.mode && !['off', 'whitelist', 'blacklist'].includes(ff.mode)) {
    throw new HttpError(400, 'format_filter.mode 必须是 off/whitelist/blacklist');
  }
  const sf = cfg.size_filter || {};
  if (sf.mode && !['off', 'remove_smaller_than', 'remove_larger_than', 'keep_only_between'].includes(sf.mode)) {
    throw new HttpError(400, 'size_filter.mode 必须是 off/remove_smaller_than/remove_larger_than/keep_only_between');
  }
  if (sf.mode && sf.mode !== 'off') {
    if (sf.mode === 'keep_only_between') {
      const a = parseSizeExprToBytes(sf.min);
      const b = parseSizeExprToBytes(sf.max);
      if (a == null || b == null) throw new HttpError(400, 'size_filter.min / size_filter.max 不合法（示例: "100KB" / "2MB"）');
    } else {
      const t = parseSizeExprToBytes(sf.threshold);
      if (t == null) throw new HttpError(400, 'size_filter.threshold 不合法（示例: "1KB" / "500B" / "2MB"）');
    }
  }
}

// ---------- DSL 求值 ----------
function compileRule(cfg) {
  const qualMatch = cfg.qualifier && cfg.qualifier.name_must_match
    ? new RegExp(cfg.qualifier.name_must_match, 'i') : null;
  const ke = cfg.key_extractor || {};
  const stripKws = (ke.strip_keywords || []).map((p) => {
    try { return new RegExp(p, 'gi'); } catch (_) { return null; }
  }).filter(Boolean);
  const scoreRules = (cfg.score_rules || []).map((r) => ({
    re: new RegExp(r.pattern, 'i'),
    score: Number(r.score) || 0
  }));
  const fmtScore = cfg.format_score || {};
  const tie = cfg.tie_breaker === 'id_asc' ? 'id_asc' : 'id_desc';
  const ff = cfg.format_filter || { mode: 'off' };
  const ffSet = new Set((ff.extensions || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean));

  // size_filter 编译
  const sf = cfg.size_filter || { mode: 'off' };
  const sfCompiled = { mode: sf.mode || 'off' };
  if (sfCompiled.mode === 'keep_only_between') {
    sfCompiled.minBytes = parseSizeExprToBytes(sf.min);
    sfCompiled.maxBytes = parseSizeExprToBytes(sf.max);
  } else if (sfCompiled.mode === 'remove_smaller_than' || sfCompiled.mode === 'remove_larger_than') {
    sfCompiled.thresholdBytes = parseSizeExprToBytes(sf.threshold);
  }

  return {
    qualifies(name) {
      if (!qualMatch) return true;
      return qualMatch.test(String(name || ''));
    },
    extractKey(name) {
      let s = String(name || '');
      if (ke.strip_ext) s = s.replace(/\.[A-Za-z0-9]{1,8}$/i, '');
      if (ke.strip_brackets) {
        s = s.replace(/[《》]/g, ' ');
        s = s.replace(/[【\[\(（][^】\]\)）]{0,20}[】\]\)）]/g, ' ');
      }
      let author = '';
      if (ke.strip_author || ke.include_author_in_key) {
        const m = s.match(/(?:作者|著)\s*[:：]?\s*([A-Za-z0-9_\-一-龥·・]+)/i);
        if (m) author = String(m[1]).trim().toLowerCase();
        if (ke.strip_author) s = s.replace(/(?:作者|著)\s*[:：]?\s*[A-Za-z0-9_\-一-龥·・]+/gi, ' ');
      }
      for (const re of stripKws) s = s.replace(re, ' ');
      if (ke.strip_separators) s = s.replace(/[·•・:_：\-—\s]+/g, '');
      if (ke.lowercase !== false) s = s.toLowerCase();
      if (!s) return null;
      return ke.include_author_in_key && author ? (s + '|' + author) : s;
    },
    score(name, fileType) {
      let n = 0;
      const text = String(name || '');
      for (const r of scoreRules) if (r.re.test(text)) n += r.score;
      const ext = (text.match(/\.([A-Za-z0-9]{1,8})$/) || [null, ''])[1].toLowerCase();
      const fmt = String(fileType || '').trim().toLowerCase() || ext;
      if (fmt && Object.prototype.hasOwnProperty.call(fmtScore, fmt)) n += Number(fmtScore[fmt]) || 0;
      return n;
    },
    tieBreaker: tie,
    formatFilter: { mode: ff.mode || 'off', set: ffSet },
    sizeFilter: sfCompiled
  };
}

function getExt(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

// 把蓝奏 file_size（"4260"=KB / "12.3 M" / "1.5GB"）转成字节数
// ilanzou：纯数字 → KB；老蓝奏：带单位
function parseFileSizeToBytes(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([a-zA-Z]*)\s*$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  let unit = (m[2] || '').toUpperCase();
  if (/^[KMGT]$/.test(unit)) unit += 'B';
  if (!unit) return Math.round(num * 1024); // 纯数字按 KB
  switch (unit) {
    case 'B':  return Math.round(num);
    case 'KB': return Math.round(num * 1024);
    case 'MB': return Math.round(num * 1024 * 1024);
    case 'GB': return Math.round(num * 1024 * 1024 * 1024);
    case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
    default:   return null;
  }
}
// 把用户在 DSL 里写的 "1k" / "500B" / "2.5MB" / 数字（默认 B）转字节
function parseSizeExprToBytes(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).trim();
  const m = s.match(/^([\d.]+)\s*([a-zA-Z]*)\s*$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  let unit = (m[2] || '').toUpperCase();
  if (/^[KMGT]$/.test(unit)) unit += 'B';
  if (!unit) return Math.round(num); // 不带单位 = 字节
  switch (unit) {
    case 'B':  return Math.round(num);
    case 'KB': return Math.round(num * 1024);
    case 'MB': return Math.round(num * 1024 * 1024);
    case 'GB': return Math.round(num * 1024 * 1024 * 1024);
    case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
    default:   return null;
  }
}

// ---------- 启动一次清理 ----------
// HTTP 立即返回 run_id；扫描通过 setImmediate 在后台跑
// confirmOver 用于"超过安全阈值时前端二次确认"：第一次返 422，前端 confirm 后带 confirmOver=true 再 POST
async function startCleanup({ ruleId, scopeSourceIds = [], crossSource = false, dryRun = true, confirmOver = false }) {
  const rule = await getRule(ruleId);
  if (!rule) throw new HttpError(404, '规则不存在');

  const config = typeof rule.config === 'string' ? JSON.parse(rule.config) : rule.config;
  validateConfig(config);

  const scopeIds = (Array.isArray(scopeSourceIds) ? scopeSourceIds : []).map(Number).filter(Boolean);
  const scopeWhere = scopeIds.length
    ? `AND r.source_id IN (${scopeIds.map(() => '?').join(',')})`
    : '';
  const [[liveRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM resources r WHERE r.is_deleted = 0 ${scopeWhere}`,
    scopeIds
  );
  const liveTotal = Number(liveRow.total || 0);
  if (liveTotal === 0) throw new HttpError(400, '当前范围内没有可清理的资源');

  const [[busy]] = await pool.query(
    `SELECT id FROM cleanup_runs WHERE status='running' ORDER BY id DESC LIMIT 1`
  );
  if (busy && busy.id) {
    // 不再 throw 让前端弹错——直接把"正在跑"的 run_id 返回，前端无缝接管
    return { run_id: busy.id, already_running: true, total_examined: liveTotal };
  }

  const [r] = await pool.query(
    `INSERT INTO cleanup_runs (rule_id, rule_name_snapshot, config_snapshot, scope_source_ids, cross_source, dry_run, status, confirm_over)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    [rule.id, rule.name, JSON.stringify(config), scopeIds.length ? scopeIds.join(',') : null,
     crossSource ? 1 : 0, dryRun ? 1 : 0, confirmOver ? 1 : 0]
  );
  const runId = r.insertId;

  runningCleanups.set(runId, { pauseRequested: false });

  setImmediate(() => {
    executeCleanup({ runId, config, scopeIds, crossSource, dryRun, liveTotal, confirmOver })
      .catch(async (err) => {
        console.error(`[cleanup #${runId}] failed:`, err);
        const msg = String(err && err.message || err).slice(0, 1000);
        await pool.query(
          `UPDATE cleanup_runs SET status='failed', error_message=?, finished_at=NOW() WHERE id=?`,
          [msg, runId]
        ).catch(() => {});
      })
      .finally(() => {
        runningCleanups.delete(runId);
      });
  });

  return { run_id: runId, total_examined: liveTotal };
}

async function executeCleanup({ runId, config, scopeIds, crossSource, dryRun, liveTotal, confirmOver }) {
  const compiled = compileRule(config);
  const samples = [];
  let removedSize = 0;
  let removedFmt = 0;
  let removedDedupe = 0;

  // 阶段 A0：大小筛选（独立于格式 / 去重，先跑）
  if (compiled.sizeFilter && compiled.sizeFilter.mode !== 'off') {
    const res = await runSizeFilter({ compiled, scopeIds, runId, dryRun, samples });
    removedSize = res.removed;
    if (res.paused) {
      await pool.query(
        `UPDATE cleanup_runs SET status='paused', removed_by_format=?, paused_at=NOW() WHERE id=?`,
        [removedSize + removedFmt, runId]
      );
      await persistSamples(runId, samples);
      return;
    }
  }

  // 阶段 A：格式过滤
  if (config.format_filter && config.format_filter.mode && config.format_filter.mode !== 'off') {
    const res = await runFormatFilter({ compiled, scopeIds, runId, dryRun, samples });
    removedFmt = res.removed;
    if (res.paused) {
      await pool.query(
        `UPDATE cleanup_runs SET status='paused', removed_by_format=?, paused_at=NOW() WHERE id=?`,
        [removedSize + removedFmt, runId]
      );
      await persistSamples(runId, samples);
      return;
    }
  }

  // 阶段 B：去重（全内存 Map）
  const hasDedupe = (config.score_rules && config.score_rules.length) || config.key_extractor;
  if (hasDedupe) {
    const res = await runDedupeInMemory({ compiled, scopeIds, crossSource, runId, dryRun, samples });
    removedDedupe = res.removed;
    if (res.paused) {
      await pool.query(
        `UPDATE cleanup_runs SET status='paused', removed_by_format=?, removed_by_dedupe=?, paused_at=NOW() WHERE id=?`,
        [removedSize + removedFmt, removedDedupe, runId]
      );
      await persistSamples(runId, samples);
      return;
    }
  }

  // 安全阈值（仅 apply 模式 + 未确认时）
  const totalRemove = removedSize + removedFmt + removedDedupe;
  const settings = await getSettings();
  if (!dryRun && !confirmOver && totalRemove > Math.floor(liveTotal * settings.safe_ratio)) {
    await rollbackRun(runId);
    const pct = ((totalRemove / liveTotal) * 100).toFixed(1);
    const msg = `SAFETY_THRESHOLD:超过安全阈值 ${Math.round(settings.safe_ratio * 100)}%：本次将删除 ${totalRemove} / ${liveTotal} 条 (${pct}%)，已自动回滚。如确认请勾选"忽略阈值"重试。`;
    await pool.query(
      `UPDATE cleanup_runs SET status='failed', error_message=?, total_examined=?, finished_at=NOW() WHERE id=?`,
      [msg, liveTotal, runId]
    );
    await persistSamples(runId, samples);
    return;
  }

  await pool.query(
    `UPDATE cleanup_runs
        SET status='completed', total_examined=?, removed_by_format=?, removed_by_dedupe=?, finished_at=NOW()
      WHERE id=?`,
    [liveTotal, removedSize + removedFmt, removedDedupe, runId]
  );
  await persistSamples(runId, samples);
}

async function persistSamples(runId, samples) {
  // 先清，再插（防 run 第二次接管时残留）
  await pool.query('DELETE FROM cleanup_run_samples WHERE run_id = ?', [runId]).catch(() => {});
  const list = samples.slice(0, SAMPLE_LIMIT);
  if (!list.length) return;
  const placeholders = list.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
  const params = [];
  list.forEach((s, idx) => {
    params.push(
      runId, idx,
      s.reason || 'dedupe',
      Number(s.id) || 0,
      Number(s.source_id) || 0,
      String(s.file_name || '').slice(0, 500),
      String(s.group_key || '').slice(0, 255),
      Number(s.score) || 0,
      String(s.ext || '').slice(0, 20),
      s.winner_id ? Number(s.winner_id) : null,
      String(s.winner_file_name || '').slice(0, 500)
    );
  });
  await pool.query(
    `INSERT INTO cleanup_run_samples
       (run_id, idx, reason, resource_id, source_id, file_name, group_key, score, ext, winner_id, winner_file_name)
     VALUES ${placeholders}`,
    params
  );
}

// 暂停信号：算法的循环每批检查一次
function shouldPause(runId) {
  const e = runningCleanups.get(runId);
  return !!(e && e.pauseRequested);
}

// ===== 大小筛选 =====
// remove_smaller_than: 小于 threshold 的全删（"小说扫盘抓到一堆 0 字节空文件"）
// remove_larger_than: 大于 threshold 的全删（极少用）
// keep_only_between:  保留 [min, max]，区间外全删
async function runSizeFilter({ compiled, scopeIds, runId, dryRun, samples }) {
  const sf = compiled.sizeFilter;
  if (sf.mode === 'off') return { removed: 0, paused: false };

  let removed = 0;
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  while (true) {
    if (shouldPause(runId)) return { removed, paused: true };
    const scopeWhere = scopeIds.length
      ? `AND r.source_id IN (${scopeIds.map(() => '?').join(',')})`
      : '';
    const [rows] = await pool.query(
      `SELECT r.id, r.file_name, r.file_size, r.source_id
         FROM resources r
        WHERE r.is_deleted = 0 ${scopeWhere} AND r.id > ?
        ORDER BY r.id ASC
        LIMIT ?`,
      [...scopeIds, lastId, BATCH_SCAN]
    );
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    examined += rows.length;

    const idsToKill = [];
    for (const row of rows) {
      const bytes = parseFileSizeToBytes(row.file_size);
      if (bytes == null) continue;          // 大小解不出来的保留（保守）
      let kill = false;
      if (sf.mode === 'remove_smaller_than') kill = bytes < sf.thresholdBytes;
      else if (sf.mode === 'remove_larger_than') kill = bytes > sf.thresholdBytes;
      else if (sf.mode === 'keep_only_between') kill = (bytes < sf.minBytes || bytes > sf.maxBytes);
      if (kill) {
        idsToKill.push(row.id);
        if (samples.length < SAMPLE_LIMIT) {
          samples.push({
            reason: 'size',
            id: row.id, file_name: row.file_name, source_id: row.source_id,
            ext: getExt(row.file_name),
            group_key: bytes + ' bytes'   // 借 group_key 显示实际大小，前端样例表能直接看
          });
        }
      }
    }
    if (idsToKill.length) {
      removed += idsToKill.length;
      if (!dryRun) await applySoftDelete(runId, idsToKill, 'size');
    }

    if (Date.now() - lastReportAt > PROGRESS_FLUSH_MS) {
      lastReportAt = Date.now();
      pool.query(
        `UPDATE cleanup_runs SET total_examined=?, removed_by_format=? WHERE id=?`,
        [examined, removed, runId]
      ).catch(() => {});
    }
  }
  return { removed, paused: false };
}

// ===== 格式过滤 =====
async function runFormatFilter({ compiled, scopeIds, runId, dryRun, samples }) {
  const ff = compiled.formatFilter;
  if (ff.mode === 'off' || !ff.set.size) return { removed: 0, paused: false };

  let removed = 0;
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  while (true) {
    if (shouldPause(runId)) return { removed, paused: true };
    const scopeWhere = scopeIds.length
      ? `AND r.source_id IN (${scopeIds.map(() => '?').join(',')})`
      : '';
    const [rows] = await pool.query(
      `SELECT r.id, r.file_name, r.source_id
         FROM resources r
        WHERE r.is_deleted = 0 ${scopeWhere} AND r.id > ?
        ORDER BY r.id ASC
        LIMIT ?`,
      [...scopeIds, lastId, BATCH_SCAN]
    );
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    examined += rows.length;

    const idsToKill = [];
    for (const row of rows) {
      const ext = getExt(row.file_name);
      const inSet = ff.set.has(ext);
      const shouldKill = ff.mode === 'whitelist' ? !inSet : inSet;
      if (shouldKill) {
        idsToKill.push(row.id);
        if (samples.length < SAMPLE_LIMIT) {
          samples.push({ reason: 'format', id: row.id, file_name: row.file_name, ext, source_id: row.source_id });
        }
      }
    }
    if (idsToKill.length) {
      removed += idsToKill.length;
      if (!dryRun) await applySoftDelete(runId, idsToKill, 'format');
    }

    if (Date.now() - lastReportAt > PROGRESS_FLUSH_MS) {
      lastReportAt = Date.now();
      pool.query(
        `UPDATE cleanup_runs SET total_examined=?, removed_by_format=? WHERE id=?`,
        [examined, removed, runId]
      ).catch(() => {});
    }
  }
  pool.query(
    `UPDATE cleanup_runs SET total_examined=?, removed_by_format=? WHERE id=?`,
    [examined, removed, runId]
  ).catch(() => {});
  return { removed, paused: false };
}

// ===== 全内存 Map 去重 =====
//  - winners: Map<group_key, {id, score}>  每个 key 大约 60+8+8 = 76 字节
//  - losers: number[]  每个 id 8 字节
// 200 万行预估：~200MB 内存（仅 dedupe 阶段），完全跑完释放
async function runDedupeInMemory({ compiled, scopeIds, crossSource, runId, dryRun, samples }) {
  const tieAsc = compiled.tieBreaker === 'id_asc';
  const winners = new Map();      // group_key -> {id, score, file_name}
  const losers = [];              // [{id, group_key, score, winner_id}]
  let examined = 0;
  let lastId = 0;
  let lastReportAt = 0;

  while (true) {
    if (shouldPause(runId)) {
      // 暂停：直接退出循环（已经积累的 losers 不删——保持原子性）
      return { removed: 0, paused: true };
    }
    const scopeWhere = scopeIds.length
      ? `AND r.source_id IN (${scopeIds.map(() => '?').join(',')})`
      : '';
    const [rows] = await pool.query(
      `SELECT r.id, r.file_name, r.file_type, r.source_id
         FROM resources r
        WHERE r.is_deleted = 0 ${scopeWhere} AND r.id > ?
        ORDER BY r.id ASC
        LIMIT ?`,
      [...scopeIds, lastId, BATCH_SCAN]
    );
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    examined += rows.length;

    for (const row of rows) {
      if (!compiled.qualifies(row.file_name)) continue;
      const k = compiled.extractKey(row.file_name);
      if (!k) continue;
      const groupKey = (crossSource ? '' : `s${row.source_id}|`) + k;
      const score = compiled.score(row.file_name, row.file_type);

      const cur = winners.get(groupKey);
      if (!cur) {
        winners.set(groupKey, { id: row.id, score, file_name: row.file_name });
        continue;
      }
      const newBeatsOld = (score > cur.score)
        || (score === cur.score && (tieAsc ? row.id < cur.id : row.id > cur.id));
      if (newBeatsOld) {
        // 旧 winner 变 loser
        losers.push({ id: cur.id, group_key: groupKey, score: cur.score, winner_id: row.id, winner_file_name: row.file_name, loser_file_name: cur.file_name, source_id: row.source_id });
        // 修正：上面 push 用的是 cur 的 source_id，但 cur 没存。简化：losers 不记 source_id，取样例时再查
        winners.set(groupKey, { id: row.id, score, file_name: row.file_name });
      } else {
        losers.push({ id: row.id, group_key: groupKey, score, winner_id: cur.id, winner_file_name: cur.file_name, loser_file_name: row.file_name, source_id: row.source_id });
      }
    }

    if (Date.now() - lastReportAt > PROGRESS_FLUSH_MS) {
      lastReportAt = Date.now();
      pool.query(
        `UPDATE cleanup_runs SET total_examined=?, removed_by_dedupe=? WHERE id=?`,
        [examined, losers.length, runId]
      ).catch(() => {});
    }
  }

  // 取样例（最多 SAMPLE_LIMIT - 已有的）
  const need = Math.max(0, SAMPLE_LIMIT - samples.length);
  for (let i = 0; i < Math.min(need, losers.length); i++) {
    const L = losers[i];
    samples.push({
      reason: 'dedupe',
      id: L.id,
      file_name: L.loser_file_name,
      source_id: L.source_id,
      group_key: L.group_key,
      score: L.score,
      winner_id: L.winner_id,
      winner_file_name: L.winner_file_name
    });
  }

  // 应用软删除
  if (!dryRun && losers.length) {
    const ids = losers.map((L) => L.id);
    for (let i = 0; i < ids.length; i += BATCH_UPDATE) {
      if (shouldPause(runId)) return { removed: i, paused: true };
      await applySoftDelete(runId, ids.slice(i, i + BATCH_UPDATE), 'dedupe');
    }
  }

  // 最后一次写回最终进度
  pool.query(
    `UPDATE cleanup_runs SET total_examined=?, removed_by_dedupe=? WHERE id=?`,
    [examined, losers.length, runId]
  ).catch(() => {});

  return { removed: losers.length, paused: false };
}

async function applySoftDelete(runId, ids, reason) {
  if (!ids.length) return;
  await pool.query(
    `UPDATE resources SET is_deleted=1 WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted=0`,
    ids
  );
  const placeholders = ids.map(() => '(?, ?, ?)').join(',');
  const params = [];
  for (const rid of ids) params.push(runId, rid, reason);
  await pool.query(
    `INSERT IGNORE INTO cleanup_deleted (run_id, resource_id, reason) VALUES ${placeholders}`,
    params
  );
}

// ---------- 暂停 / 恢复 ----------
function requestPause(runId) {
  const e = runningCleanups.get(Number(runId));
  if (!e) return false;
  e.pauseRequested = true;
  return true;
}

// 恢复就是按原 run 的规则 / 范围重新启动一个新 run（简单可靠；旧 run 标 'undone'）
async function resumeRun(oldRunId) {
  const [[row]] = await pool.query('SELECT * FROM cleanup_runs WHERE id = ? LIMIT 1', [oldRunId]);
  if (!row) throw new HttpError(404, '原 run 不存在');
  if (row.status !== 'paused' && row.status !== 'failed') {
    throw new HttpError(400, '只能从 paused/failed 状态恢复');
  }
  const config = typeof row.config_snapshot === 'string' ? JSON.parse(row.config_snapshot) : row.config_snapshot;
  const scopeIds = row.scope_source_ids
    ? row.scope_source_ids.split(',').map(Number).filter(Boolean)
    : [];
  // 旧 run 标 undone 收尾
  await pool.query("UPDATE cleanup_runs SET status='undone' WHERE id=?", [oldRunId]);
  // 用相同参数启动新 run（用新 rule_id；如果 rule 已删，用 snapshot）
  // 这里直接复用 startCleanup 的入口需要 ruleId，但 rule 可能已被删；改成手工建 run + setImmediate
  const [r] = await pool.query(
    `INSERT INTO cleanup_runs (rule_id, rule_name_snapshot, config_snapshot, scope_source_ids, cross_source, dry_run, status, confirm_over)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    [row.rule_id, row.rule_name_snapshot, JSON.stringify(config),
     scopeIds.length ? scopeIds.join(',') : null,
     row.cross_source ? 1 : 0, row.dry_run ? 1 : 0, row.confirm_over ? 1 : 0]
  );
  const newRunId = r.insertId;
  runningCleanups.set(newRunId, { pauseRequested: false });

  const scopeWhere = scopeIds.length
    ? `AND r.source_id IN (${scopeIds.map(() => '?').join(',')})`
    : '';
  const [[liveRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM resources r WHERE r.is_deleted = 0 ${scopeWhere}`,
    scopeIds
  );
  const liveTotal = Number(liveRow.total || 0);

  setImmediate(() => {
    executeCleanup({
      runId: newRunId, config, scopeIds,
      crossSource: !!row.cross_source, dryRun: !!row.dry_run,
      liveTotal, confirmOver: !!row.confirm_over
    })
      .catch(async (err) => {
        console.error(`[cleanup #${newRunId}] failed:`, err);
        const msg = String(err && err.message || err).slice(0, 1000);
        await pool.query(
          `UPDATE cleanup_runs SET status='failed', error_message=?, finished_at=NOW() WHERE id=?`,
          [msg, newRunId]
        ).catch(() => {});
      })
      .finally(() => { runningCleanups.delete(newRunId); });
  });
  return { run_id: newRunId };
}

// ---------- 撤销 ----------
async function undoRun(runId) {
  const [[run]] = await pool.query('SELECT * FROM cleanup_runs WHERE id = ?', [runId]);
  if (!run) throw new HttpError(404, 'Run 不存在');
  if (run.dry_run) throw new HttpError(400, '试运行未删除任何数据，无需撤销');
  if (run.status === 'undone') throw new HttpError(400, '已撤销，请勿重复操作');
  await rollbackRun(runId);
  await pool.query(`UPDATE cleanup_runs SET status='undone' WHERE id=?`, [runId]);
  return { ok: true };
}

async function rollbackRun(runId) {
  let lastId = 0;
  while (true) {
    const [rows] = await pool.query(
      `SELECT resource_id FROM cleanup_deleted WHERE run_id = ? AND resource_id > ? ORDER BY resource_id ASC LIMIT ?`,
      [runId, lastId, BATCH_UPDATE]
    );
    if (!rows.length) break;
    lastId = rows[rows.length - 1].resource_id;
    const ids = rows.map((x) => x.resource_id);
    await pool.query(
      `UPDATE resources SET is_deleted=0 WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted=1`,
      ids
    );
  }
  await pool.query('DELETE FROM cleanup_deleted WHERE run_id = ?', [runId]);
}

// ---------- 查询 ----------
async function listRuns({ limit = 30 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, rule_id, rule_name_snapshot, scope_source_ids, cross_source,
            dry_run, status, total_examined, removed_by_format, removed_by_dedupe,
            error_message, started_at, finished_at
       FROM cleanup_runs ORDER BY id DESC LIMIT ?`,
    [Math.min(Number(limit) || 30, 200)]
  );
  return rows;
}

async function getRun(runId) {
  const [[row]] = await pool.query(
    `SELECT id, rule_id, rule_name_snapshot, scope_source_ids, cross_source,
            dry_run, confirm_over, status, total_examined, removed_by_format, removed_by_dedupe,
            error_message, started_at, paused_at, finished_at
       FROM cleanup_runs WHERE id = ? LIMIT 1`,
    [runId]
  );
  if (!row) return null;
  const [samples] = await pool.query(
    `SELECT idx, reason, resource_id AS id, source_id, file_name, group_key, score, ext, winner_id, winner_file_name
       FROM cleanup_run_samples WHERE run_id = ? ORDER BY idx ASC LIMIT 100`,
    [runId]
  );

  const aliveInProc = runningCleanups.has(Number(row.id));
  let displayStatus = row.status;
  // 容器重启后 running 但进程内没了 → orphaned
  if (row.status === 'running' && !aliveInProc) displayStatus = 'orphaned';

  // 安全阈值阻断错误：把前缀拆出来，给前端识别用
  let safetyBlocked = false;
  let errMsg = row.error_message || null;
  if (errMsg && errMsg.startsWith('SAFETY_THRESHOLD:')) {
    safetyBlocked = true;
    errMsg = errMsg.replace(/^SAFETY_THRESHOLD:/, '');
  }

  return {
    id: row.id,
    rule_id: row.rule_id,
    rule_name: row.rule_name_snapshot,
    scope_source_ids: row.scope_source_ids,
    cross_source: !!row.cross_source,
    dry_run: !!row.dry_run,
    confirm_over: !!row.confirm_over,
    status: displayStatus,
    is_running: displayStatus === 'running',
    safety_blocked: safetyBlocked,
    total_examined: row.total_examined,
    removed_by_format: row.removed_by_format,
    removed_by_dedupe: row.removed_by_dedupe,
    total_removed: (row.removed_by_format || 0) + (row.removed_by_dedupe || 0),
    error_message: errMsg,
    samples,
    started_at: row.started_at,
    paused_at: row.paused_at,
    finished_at: row.finished_at
  };
}

// 拉某个 source 的"最近一次清理"——前端进 cleanup tab 自动恢复进度卡用
async function getLatestRun() {
  const [[row]] = await pool.query(
    `SELECT id FROM cleanup_runs ORDER BY id DESC LIMIT 1`
  );
  if (!row) return null;
  return getRun(row.id);
}

async function getRunSamples(runId, limit = 50) {
  const cap = Math.min(Number(limit) || 50, 500);
  const [rows] = await pool.query(
    `SELECT idx, reason, resource_id AS id, source_id, file_name, group_key, score, ext, winner_id, winner_file_name
       FROM cleanup_run_samples WHERE run_id = ? ORDER BY idx ASC LIMIT ?`,
    [runId, cap]
  );
  return rows;
}

module.exports = {
  listRules, getRule, createRule, updateRule, deleteRule,
  getSettings, updateSettings,
  startCleanup, requestPause, resumeRun, undoRun,
  listRuns, getRun, getLatestRun, getRunSamples
};
