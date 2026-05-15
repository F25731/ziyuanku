// 阶段7：清理/去重服务
// 设计要点：
//  - 规则用 JSON DSL 表达，不跑用户写的 JS（安全 + 可导入导出）
//  - 大表操作全部分批：每批 5000~50000 行，不会全表锁
//  - 软删除（is_deleted=1），所有删的行写到 cleanup_deleted，可一键撤销
//  - 临时分组表 _cleanup_temp 跑完清空（DELETE，不 DROP）

const { pool } = require('../config/db');
const HttpError = require('../utils/httpError');

const BATCH_SCAN = 5000;       // 一次从 resources 拉多少行
const BATCH_UPDATE = 20000;    // UPDATE 一次最多动多少行
const SAFE_DELETE_RATIO = 0.5; // 单次最多删活跃资源的 50%，超过 abort（防误删）
const SAMPLE_LIMIT = 50;       // dry-run 返回的样例条数

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

// ---------- 配置校验：保证用户传进来的 JSON 不会让运行炸 ----------
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new HttpError(400, 'config 必须是对象');
  // qualifier 可空，空就是全部资源都参与
  if (cfg.qualifier && cfg.qualifier.name_must_match) {
    try { new RegExp(cfg.qualifier.name_must_match); }
    catch (_) { throw new HttpError(400, 'qualifier.name_must_match 不是合法正则'); }
  }
  // score_rules 里的 pattern 都得是合法正则
  if (Array.isArray(cfg.score_rules)) {
    for (const r of cfg.score_rules) {
      try { new RegExp(r.pattern); }
      catch (_) { throw new HttpError(400, `score_rules 里 ${r.pattern} 不是合法正则`); }
    }
  }
  // format_filter
  const ff = cfg.format_filter || {};
  if (ff.mode && !['off', 'whitelist', 'blacklist'].includes(ff.mode)) {
    throw new HttpError(400, 'format_filter.mode 必须是 off/whitelist/blacklist');
  }
}

// ---------- DSL 求值：单条资源 → group_key + score ----------
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
    formatFilter: { mode: ff.mode || 'off', set: ffSet }
  };
}

function getExt(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

// ---------- run 一次清理 ----------
// 立即返回 run_id，真正的扫描放到后台跑——避免 HTTP 90s 超时；
// 前端轮询 GET /cleanup/runs/:id 看进度
async function startCleanup({ ruleId, scopeSourceIds = [], crossSource = false, dryRun = true, ruleConfigOverride = null }) {
  const rule = await getRule(ruleId);
  if (!rule) throw new HttpError(404, '规则不存在');
  if (!rule.enabled && !ruleConfigOverride) throw new HttpError(400, '规则已禁用');

  const config = ruleConfigOverride || (typeof rule.config === 'string' ? JSON.parse(rule.config) : rule.config);
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

  // 同一时间最多一个 run，防止用户连点
  const [[busy]] = await pool.query(
    `SELECT id FROM cleanup_runs WHERE status='running' ORDER BY id DESC LIMIT 1`
  );
  if (busy && busy.id) {
    throw new HttpError(409, `已有清理任务在跑（run #${busy.id}），请等待完成或刷新页面查看`);
  }

  const [r] = await pool.query(
    `INSERT INTO cleanup_runs (rule_id, rule_name_snapshot, config_snapshot, scope_source_ids, cross_source, dry_run, status)
     VALUES (?, ?, ?, ?, ?, ?, 'running')`,
    [rule.id, rule.name, JSON.stringify(config), scopeIds.length ? scopeIds.join(',') : null,
     crossSource ? 1 : 0, dryRun ? 1 : 0]
  );
  const runId = r.insertId;

  // 后台跑（不 await，让 HTTP 立即返回）
  setImmediate(() => {
    executeCleanup({ runId, config, scopeIds, crossSource, dryRun, liveTotal })
      .catch((err) => {
        console.error(`[cleanup #${runId}] failed:`, err);
        pool.query(
          `UPDATE cleanup_runs SET status='failed', error_message=?, finished_at=NOW() WHERE id=?`,
          [String(err.message || err).slice(0, 500), runId]
        ).catch(() => {});
      });
  });

  return { run_id: runId, total_examined: liveTotal };
}

async function executeCleanup({ runId, config, scopeIds, crossSource, dryRun, liveTotal }) {
  const compiled = compileRule(config);
  const samples = [];
  let removedFmt = 0;
  let removedDedupe = 0;

  // 把"将存为 result_summary"的样例先写到 cleanup_runs.error_message 里？
  // 不，单独一个表太重，直接挂在内存里、跑完写 cleanup_run_samples 也可以。
  // 但前端只要看进度数字，样例放在 cleanup_deleted 也能 JOIN 查到，先不做样例写库。

  if (config.format_filter && config.format_filter.mode && config.format_filter.mode !== 'off') {
    const res = await runFormatFilter({
      compiled, scopeIds, runId, dryRun, samples
    });
    removedFmt = res.removed;
  }

  const hasDedupe = (config.score_rules && config.score_rules.length) || config.key_extractor;
  if (hasDedupe) {
    const res = await runDedupe({
      compiled, scopeIds, crossSource, runId, dryRun, samples
    });
    removedDedupe = res.removed;
  }

  // 安全阈值（dry-run 不强制）
  const totalRemove = removedFmt + removedDedupe;
  if (!dryRun && totalRemove > Math.floor(liveTotal * SAFE_DELETE_RATIO)) {
    await rollbackRun(runId);
    const msg = `安全阈值阻断：本次将删除 ${totalRemove} / ${liveTotal} 条 (超过 ${Math.floor(SAFE_DELETE_RATIO * 100)}%)，已自动回滚`;
    await pool.query(
      `UPDATE cleanup_runs SET status='failed', error_message=?, finished_at=NOW() WHERE id=?`,
      [msg, runId]
    );
    return;
  }

  // 把样例 JSON 存到 error_message（复用字段，前端取来展示）
  // 名字叫 error_message 但实际兼做"结果摘要"——避免再加表
  const samplesJson = JSON.stringify(samples.slice(0, SAMPLE_LIMIT));
  await pool.query(
    `UPDATE cleanup_runs
        SET status='completed', total_examined=?, removed_by_format=?, removed_by_dedupe=?,
            error_message=?, finished_at=NOW()
      WHERE id=?`,
    [liveTotal, removedFmt, removedDedupe, samplesJson.slice(0, 16000), runId]
  );
}

// 兼容旧调用：admin.js 仍可调 runCleanup（同步等完）；
// 实际用 startCleanup 启动后台 + 立即返回
async function runCleanup(opts) {
  return startCleanup(opts);
}
// ===== 格式过滤 =====
async function runFormatFilter({ compiled, scopeIds, runId, dryRun, samples }) {
  const ff = compiled.formatFilter;
  if (ff.mode === 'off') return { removed: 0 };
  if (!ff.set.size) return { removed: 0 };

  let removed = 0;
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  while (true) {
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
      if (!dryRun) {
        for (let i = 0; i < idsToKill.length; i += BATCH_UPDATE) {
          const slice = idsToKill.slice(i, i + BATCH_UPDATE);
          await pool.query(
            `UPDATE resources SET is_deleted=1 WHERE id IN (${slice.map(() => '?').join(',')}) AND is_deleted=0`,
            slice
          );
          const valueRows = slice.map(() => '(?, ?, ?)').join(',');
          const valueParams = [];
          for (const rid of slice) valueParams.push(runId, rid, 'format');
          await pool.query(
            `INSERT IGNORE INTO cleanup_deleted (run_id, resource_id, reason) VALUES ${valueRows}`,
            valueParams
          );
        }
      }
    }

    // 每 2 秒回写一次进度，前端轮询读
    if (Date.now() - lastReportAt > 2000) {
      lastReportAt = Date.now();
      pool.query(
        `UPDATE cleanup_runs SET total_examined=?, removed_by_format=? WHERE id=?`,
        [examined, removed, runId]
      ).catch(() => {});
    }
  }
  return { removed };
}

// ===== 去重 =====
async function runDedupe({ compiled, scopeIds, crossSource, runId, dryRun, samples }) {
  // 1) 流式扫描，写 _cleanup_temp（每行的 group_key + score）
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  while (true) {
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

    const buf = [];
    for (const row of rows) {
      if (!compiled.qualifies(row.file_name)) continue;
      const k = compiled.extractKey(row.file_name);
      if (!k) continue;
      // 跨库 vs 库内独立：库内独立时把 source_id 拼到 group_key 里
      const groupKey = (crossSource ? '' : `s${row.source_id}|`) + k;
      const score = compiled.score(row.file_name, row.file_type);
      buf.push([runId, row.id, groupKey.slice(0, 250), score]);
    }
    if (buf.length) {
      const placeholders = buf.map(() => '(?, ?, ?, ?)').join(',');
      const flat = [];
      for (const b of buf) flat.push(...b);
      await pool.query(
        `INSERT INTO _cleanup_temp (run_id, resource_id, group_key, score) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE score = VALUES(score), group_key = VALUES(group_key)`,
        flat
      );
    }

    // 节流回写扫描进度（去重阶段，removed 暂时还没算）
    if (Date.now() - lastReportAt > 2000) {
      lastReportAt = Date.now();
      pool.query(
        `UPDATE cleanup_runs SET total_examined=? WHERE id=?`,
        [examined, runId]
      ).catch(() => {});
    }
  }

  // 2) 在 _cleanup_temp 里找每组 winner（score DESC, id 按 tie_breaker），其他都标记
  // MySQL 8 ROW_NUMBER；找出 rn>1 的就是要删的
  const orderId = compiled.tieBreaker === 'id_asc' ? 'ASC' : 'DESC';
  const [losers] = await pool.query(
    `SELECT t.resource_id, t.group_key, t.score
       FROM (
         SELECT resource_id, group_key, score,
                ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY score DESC, resource_id ${orderId}) AS rn
           FROM _cleanup_temp
          WHERE run_id = ?
       ) t
      WHERE t.rn > 1`,
    [runId]
  );
  const idsToKill = losers.map((x) => x.resource_id);

  // 取样例（带文件名）
  if (samples.length < SAMPLE_LIMIT && idsToKill.length) {
    const need = SAMPLE_LIMIT - samples.length;
    const sampleIds = idsToKill.slice(0, need);
    const [sampleRows] = await pool.query(
      `SELECT r.id, r.file_name, r.source_id, t.group_key, t.score
         FROM resources r JOIN _cleanup_temp t ON t.resource_id = r.id AND t.run_id = ?
        WHERE r.id IN (${sampleIds.map(() => '?').join(',')})`,
      [runId, ...sampleIds]
    );
    for (const sr of sampleRows) {
      samples.push({ reason: 'dedupe', id: sr.id, file_name: sr.file_name, source_id: sr.source_id, group_key: sr.group_key, score: sr.score });
    }
  }

  if (!dryRun && idsToKill.length) {
    for (let i = 0; i < idsToKill.length; i += BATCH_UPDATE) {
      const slice = idsToKill.slice(i, i + BATCH_UPDATE);
      await pool.query(
        `UPDATE resources SET is_deleted=1 WHERE id IN (${slice.map(() => '?').join(',')}) AND is_deleted=0`,
        slice
      );
      const valueRows = slice.map(() => '(?, ?, ?)').join(',');
      const valueParams = [];
      for (const rid of slice) valueParams.push(runId, rid, 'dedupe');
      await pool.query(
        `INSERT IGNORE INTO cleanup_deleted (run_id, resource_id, reason) VALUES ${valueRows}`,
        valueParams
      );
    }
  }

  // 3) 清理临时表（只删本次 run 的行）
  await pool.query('DELETE FROM _cleanup_temp WHERE run_id = ?', [runId]);

  return { removed: idsToKill.length, examined };
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
  // 分批从 cleanup_deleted 拉 ids，把 is_deleted 改回 0
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

async function listRuns({ limit = 30 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, rule_id, rule_name_snapshot, scope_source_ids, cross_source,
            dry_run, status, total_examined, removed_by_format, removed_by_dedupe,
            error_message, started_at, finished_at
       FROM cleanup_runs ORDER BY id DESC LIMIT ?`,
    [Math.min(Number(limit) || 30, 200)]
  );
  // 跑完的 run 里 error_message 装的是 samples JSON，前端不需要看；只在 status=failed 时返回
  for (const r of rows) {
    if (r.status !== 'failed' && r.error_message) r.error_message = null;
  }
  return rows;
}

// 单 run 详情：前端轮询用
async function getRun(runId) {
  const [[row]] = await pool.query(
    `SELECT id, rule_id, rule_name_snapshot, scope_source_ids, cross_source,
            dry_run, status, total_examined, removed_by_format, removed_by_dedupe,
            error_message, started_at, finished_at
       FROM cleanup_runs WHERE id = ? LIMIT 1`,
    [runId]
  );
  if (!row) return null;
  // status=completed 时 error_message 复用为 samples JSON
  let samples = null;
  let errorMessage = null;
  if (row.error_message) {
    if (row.status === 'failed') {
      errorMessage = row.error_message;
    } else {
      try { samples = JSON.parse(row.error_message); } catch (_) { samples = null; }
    }
  }
  return {
    id: row.id,
    rule_id: row.rule_id,
    rule_name: row.rule_name_snapshot,
    scope_source_ids: row.scope_source_ids,
    cross_source: !!row.cross_source,
    dry_run: !!row.dry_run,
    status: row.status,
    total_examined: row.total_examined,
    removed_by_format: row.removed_by_format,
    removed_by_dedupe: row.removed_by_dedupe,
    total_removed: (row.removed_by_format || 0) + (row.removed_by_dedupe || 0),
    error_message: errorMessage,
    samples,
    started_at: row.started_at,
    finished_at: row.finished_at
  };
}

async function getRunSamples(runId, limit = 50) {
  const cap = Math.min(Number(limit) || 50, 500);
  const [rows] = await pool.query(
    `SELECT d.run_id, d.resource_id, d.reason, r.file_name, r.source_id, r.is_deleted
       FROM cleanup_deleted d LEFT JOIN resources r ON r.id = d.resource_id
      WHERE d.run_id = ? LIMIT ?`,
    [runId, cap]
  );
  return rows;
}

module.exports = {
  listRules, getRule, createRule, updateRule, deleteRule,
  runCleanup, startCleanup, undoRun, listRuns, getRun, getRunSamples
};
