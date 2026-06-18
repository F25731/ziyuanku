const { pool } = require('../config/db');
const searchOutbox = require('./searchIndexOutboxService');
const HttpError = require('../utils/httpError');

const BATCH_SCAN = Math.max(500, Number(process.env.CLEANUP_SCAN_BATCH || 5000));
const BATCH_WRITE = Math.max(500, Number(process.env.CLEANUP_WRITE_BATCH || 5000));
const GROUP_BATCH = Math.max(20, Number(process.env.CLEANUP_GROUP_BATCH || 200));
const TEMP_DELETE_BATCH = Math.max(5000, Number(process.env.CLEANUP_TEMP_DELETE_BATCH || 50000));
const STALE_SECONDS = Math.max(60, Number(process.env.CLEANUP_WORKER_STALE_SECONDS || 600));
const SAMPLE_LIMIT = 50;
const PROGRESS_FLUSH_MS = 2000;
const WORKER_ID = `${process.env.HOSTNAME || 'cleanup-worker'}:${process.pid}`;

const ACTIVE_STATUSES = ['queued', 'running', 'apply_queued', 'applying'];

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
  if (!Number.isFinite(r)) throw new HttpError(400, 'safeRatio invalid');
  await pool.query(
    'INSERT INTO cleanup_settings (id, safe_ratio) VALUES (1, ?) ON DUPLICATE KEY UPDATE safe_ratio = VALUES(safe_ratio)',
    [r]
  );
  return getSettings();
}

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
  if (!name || !config) throw new HttpError(400, 'name and config are required');
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

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new HttpError(400, 'config must be an object');
  if (cfg.qualifier && cfg.qualifier.name_must_match) {
    try { new RegExp(cfg.qualifier.name_must_match); }
    catch (_) { throw new HttpError(400, 'qualifier.name_must_match is not a valid regexp'); }
  }
  if (Array.isArray(cfg.score_rules)) {
    for (const r of cfg.score_rules) {
      try { new RegExp(r.pattern); }
      catch (_) { throw new HttpError(400, `score_rules pattern is invalid: ${r.pattern}`); }
    }
  }
  const ff = cfg.format_filter || {};
  if (ff.mode && !['off', 'whitelist', 'blacklist'].includes(ff.mode)) {
    throw new HttpError(400, 'format_filter.mode must be off/whitelist/blacklist');
  }
  const sf = cfg.size_filter || {};
  if (sf.mode && !['off', 'remove_smaller_than', 'remove_larger_than', 'keep_only_between'].includes(sf.mode)) {
    throw new HttpError(400, 'size_filter.mode is invalid');
  }
  if (sf.mode && sf.mode !== 'off') {
    if (sf.mode === 'keep_only_between') {
      const a = parseSizeExprToBytes(sf.min);
      const b = parseSizeExprToBytes(sf.max);
      if (a == null || b == null || a > b) throw new HttpError(400, 'size_filter min/max invalid');
    } else {
      const t = parseSizeExprToBytes(sf.threshold);
      if (t == null) throw new HttpError(400, 'size_filter threshold invalid');
    }
  }
}

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
      let s = normalizeNameForCleanup(name);
      if (ke.strip_ext) s = s.replace(/\.[A-Za-z0-9]{1,8}$/i, '');
      if (ke.strip_brackets) {
        s = s.replace(/[《〈「『](.*?)[》〉」』]/g, '$1');
        s = s.replace(/[\[【(（][^\]】)）]{0,80}[\]】)）]/g, ' ');
      }
      let author = '';
      if (ke.strip_author || ke.include_author_in_key) {
        const m = s.match(/(?:作者|著)\s*[:：]?\s*([A-Za-z0-9_\-\u4e00-\u9fa5·.]+)/i);
        if (m) author = String(m[1]).trim().toLowerCase();
        if (ke.strip_author) {
          s = s.replace(/(?:作者|著)\s*[:：]?\s*[A-Za-z0-9_\-\u4e00-\u9fa5·.]+/gi, ' ');
        }
      }
      for (const re of stripKws) s = s.replace(re, ' ');
      if (ke.strip_separators) s = s.replace(/[\s·•・_:：\-—–|,，.。]+/g, '');
      if (ke.lowercase !== false) s = s.toLowerCase();
      s = s.trim();
      if (!s) return null;
      return ke.include_author_in_key && author ? `${s}|${author}` : s;
    },
    score(name, fileType) {
      let n = 0;
      const text = String(name || '');
      for (const r of scoreRules) if (r.re.test(text)) n += r.score;
      const ext = getExt(text);
      const fmt = String(fileType || '').trim().toLowerCase() || ext;
      if (fmt && Object.prototype.hasOwnProperty.call(fmtScore, fmt)) n += Number(fmtScore[fmt]) || 0;
      return n;
    },
    tieBreaker: tie,
    formatFilter: { mode: ff.mode || 'off', set: ffSet },
    sizeFilter: sfCompiled
  };
}

function normalizeNameForCleanup(name) {
  return String(name || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&lsquo;|&rsquo;|&#8216;|&#8217;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .normalize('NFKC');
}

function getExt(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

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
  if (!unit) return Math.round(num * 1024);
  switch (unit) {
    case 'B': return Math.round(num);
    case 'KB': return Math.round(num * 1024);
    case 'MB': return Math.round(num * 1024 * 1024);
    case 'GB': return Math.round(num * 1024 * 1024 * 1024);
    case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
    default: return null;
  }
}

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
  if (!unit) return Math.round(num);
  switch (unit) {
    case 'B': return Math.round(num);
    case 'KB': return Math.round(num * 1024);
    case 'MB': return Math.round(num * 1024 * 1024);
    case 'GB': return Math.round(num * 1024 * 1024 * 1024);
    case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
    default: return null;
  }
}

function scopeWhere(scopeIds, alias = 'r') {
  const ids = (Array.isArray(scopeIds) ? scopeIds : []).map(Number).filter(Boolean);
  return {
    sql: ids.length ? `AND ${alias}.source_id IN (${ids.map(() => '?').join(',')})` : '',
    params: ids
  };
}

async function countLiveResources(scopeIds) {
  const scope = scopeWhere(scopeIds, 'r');
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total FROM resources r WHERE r.is_deleted = 0 ${scope.sql}`,
    scope.params
  );
  return Number(row.total || 0);
}

function activePlaceholders() {
  return ACTIVE_STATUSES.map(() => '?').join(',');
}

async function getRunStatus(runId) {
  const [[row]] = await pool.query('SELECT status FROM cleanup_runs WHERE id=? LIMIT 1', [Number(runId)]);
  return row ? row.status : null;
}

async function shouldContinue(runId, status) {
  return (await getRunStatus(runId)) === status;
}

async function heartbeat(runId, patch = {}) {
  const fields = ['worker_id=?', 'worker_heartbeat_at=NOW()'];
  const params = [WORKER_ID];
  if (patch.error_message !== undefined) {
    fields.push('error_message=?');
    params.push(patch.error_message);
  }
  if (patch.total_examined !== undefined) {
    fields.push('total_examined=?');
    params.push(Number(patch.total_examined) || 0);
  }
  if (patch.last_scanned_id !== undefined) {
    fields.push('last_scanned_id=?');
    params.push(Number(patch.last_scanned_id) || 0);
  }
  if (patch.applied_total !== undefined) {
    fields.push('applied_total=?');
    params.push(Number(patch.applied_total) || 0);
  }
  params.push(Number(runId));
  await pool.query(`UPDATE cleanup_runs SET ${fields.join(', ')} WHERE id=?`, params).catch(() => {});
}

async function markStaleWorkerRuns() {
  const seconds = Math.max(60, Number(STALE_SECONDS) || 600);
  await pool.query(
    `UPDATE cleanup_runs
        SET status='paused',
            error_message=CONCAT(COALESCE(error_message, ''), IF(error_message IS NULL OR error_message='', '', '\n'), 'worker heartbeat stale; auto paused'),
            paused_at=NOW(),
            worker_id=NULL
      WHERE status IN ('running','applying')
        AND worker_heartbeat_at IS NOT NULL
        AND worker_heartbeat_at < DATE_SUB(NOW(), INTERVAL ${seconds} SECOND)`
  ).catch(() => {});
}

async function deleteRunRows(table, runId, { heartbeatMessage = null } = {}) {
  const limit = Math.max(1, Number(TEMP_DELETE_BATCH) || 50000);
  while (true) {
    if (heartbeatMessage) await heartbeat(runId, { error_message: heartbeatMessage });
    const [r] = await pool.query(`DELETE FROM ${table} WHERE run_id=? LIMIT ${limit}`, [Number(runId)]);
    if (!r.affectedRows || r.affectedRows < limit) break;
  }
}

async function clearRunWorkingData(runId, { includeCandidates = true, quiet = false } = {}) {
  if (includeCandidates) await deleteRunRows('cleanup_candidates', runId, { heartbeatMessage: quiet ? null : '正在清理上次候选数据...' });
  await deleteRunRows('cleanup_dedupe_keys', runId, { heartbeatMessage: quiet ? null : '正在清理去重临时数据...' });
  await deleteRunRows('cleanup_dedupe_groups', runId, { heartbeatMessage: quiet ? null : '正在清理去重分组数据...' });
  await pool.query('DELETE FROM cleanup_run_samples WHERE run_id=?', [Number(runId)]).catch(() => {});
  await pool.query('DELETE FROM cleanup_deleted WHERE run_id=?', [Number(runId)]).catch(() => {});
}

async function startCleanup({ ruleId, scopeSourceIds = [], crossSource = false, dryRun = true } = {}) {
  const rule = await getRule(ruleId);
  if (!rule) throw new HttpError(404, 'cleanup rule not found');
  const config = typeof rule.config === 'string' ? JSON.parse(rule.config) : rule.config;
  validateConfig(config);

  const scopeIds = (Array.isArray(scopeSourceIds) ? scopeSourceIds : []).map(Number).filter(Boolean);
  const liveTotal = await countLiveResources(scopeIds);
  if (liveTotal === 0) throw new HttpError(400, 'no live resources in this scope');

  const [[busy]] = await pool.query(
    `SELECT id FROM cleanup_runs WHERE status IN (${activePlaceholders()}) ORDER BY id DESC LIMIT 1`,
    ACTIVE_STATUSES
  );
  if (busy && busy.id) return { run_id: busy.id, already_running: true, total_examined: liveTotal };

  const [r] = await pool.query(
    `INSERT INTO cleanup_runs
       (rule_id, rule_name_snapshot, config_snapshot, scope_source_ids, cross_source, dry_run, status, confirm_over, total_examined)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
    [
      rule.id,
      rule.name,
      JSON.stringify(config),
      scopeIds.length ? scopeIds.join(',') : null,
      crossSource ? 1 : 0,
      dryRun ? 1 : 0,
      0
    ]
  );
  const runId = r.insertId;

  return { run_id: runId, total_examined: liveTotal };
}

async function generateCandidates({ runId, config, scopeIds, crossSource, liveTotal }) {
  const compiled = compileRule(config);
  await clearRunWorkingData(runId, { includeCandidates: true });
  await heartbeat(runId, { error_message: '正在扫描资源并生成候选...' });

  let scanned = 0;
  if (compiled.sizeFilter && compiled.sizeFilter.mode !== 'off') {
    scanned = Math.max(scanned, await generateSizeCandidates({ runId, compiled, scopeIds }));
    if (!(await shouldContinue(runId, 'running'))) return pauseRun(runId);
  }
  if (config.format_filter && config.format_filter.mode && config.format_filter.mode !== 'off') {
    scanned = Math.max(scanned, await generateFormatCandidates({ runId, compiled, scopeIds }));
    if (!(await shouldContinue(runId, 'running'))) return pauseRun(runId);
  }
  const hasDedupe = (config.score_rules && config.score_rules.length) || config.key_extractor;
  if (hasDedupe) {
    scanned = Math.max(scanned, await generateDedupeCandidates({ runId, compiled, scopeIds, crossSource }));
    if (!(await shouldContinue(runId, 'running'))) return pauseRun(runId);
  }

  await refreshRunCounts(runId, liveTotal || scanned);
  await persistSamplesFromCandidates(runId);
  await pool.query(
    "UPDATE cleanup_runs SET status='review_ready', worker_id=NULL, worker_heartbeat_at=NULL, total_examined=?, finished_at=NOW(), error_message=NULL WHERE id=? AND status='running'",
    [liveTotal || scanned, runId]
  );
  await clearRunWorkingData(runId, { includeCandidates: false, quiet: true });
}

async function pauseRun(runId) {
  await refreshRunCounts(runId);
  await persistSamplesFromCandidates(runId);
  await pool.query("UPDATE cleanup_runs SET status='paused', paused_at=NOW(), worker_id=NULL, worker_heartbeat_at=NULL WHERE id=? AND status IN ('running','applying')", [runId]);
}

async function insertCandidates(rows) {
  if (!rows.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_WRITE) {
    const chunk = rows.slice(i, i + BATCH_WRITE);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const params = [];
    for (const c of chunk) {
      params.push(
        c.run_id,
        c.resource_id,
        c.reason,
        c.source_id,
        String(c.file_name || '').slice(0, 500),
        c.group_key ? String(c.group_key).slice(0, 255) : null,
        Number(c.score) || 0,
        c.ext ? String(c.ext).slice(0, 20) : null,
        c.size_bytes == null ? null : Number(c.size_bytes),
        c.winner_id || null,
        c.winner_file_name ? String(c.winner_file_name).slice(0, 500) : null
      );
    }
    const [r] = await pool.query(
      `INSERT IGNORE INTO cleanup_candidates
        (run_id, resource_id, reason, source_id, file_name, group_key, score, ext, size_bytes, winner_id, winner_file_name)
       VALUES ${placeholders}`,
      params
    );
    inserted += r.affectedRows || 0;
  }
  return inserted;
}

async function generateSizeCandidates({ runId, compiled, scopeIds }) {
  const sf = compiled.sizeFilter;
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  const scope = scopeWhere(scopeIds, 'r');
  while (true) {
    if (!(await shouldContinue(runId, 'running'))) return examined;
    const [rows] = await pool.query(
      `SELECT r.id, r.source_id, r.file_name, r.file_size
         FROM resources r
        WHERE r.is_deleted = 0 ${scope.sql} AND r.id > ?
        ORDER BY r.id ASC
        LIMIT ?`,
      [...scope.params, lastId, BATCH_SCAN]
    );
    if (!rows.length) break;
    lastId = Number(rows[rows.length - 1].id);
    examined += rows.length;

    const candidates = [];
    for (const row of rows) {
      const bytes = parseFileSizeToBytes(row.file_size);
      if (bytes == null) continue;
      let kill = false;
      if (sf.mode === 'remove_smaller_than') kill = bytes < sf.thresholdBytes;
      else if (sf.mode === 'remove_larger_than') kill = bytes > sf.thresholdBytes;
      else if (sf.mode === 'keep_only_between') kill = bytes < sf.minBytes || bytes > sf.maxBytes;
      if (kill) {
        candidates.push({
          run_id: runId,
          resource_id: row.id,
          reason: 'size',
          source_id: row.source_id,
          file_name: row.file_name,
          group_key: `${bytes} bytes`,
          ext: getExt(row.file_name),
          size_bytes: bytes
        });
      }
    }
    await insertCandidates(candidates);
    if (Date.now() - lastReportAt > PROGRESS_FLUSH_MS) {
      lastReportAt = Date.now();
      await progress(runId, examined, lastId);
    }
  }
  await progress(runId, examined, lastId);
  return examined;
}

async function generateFormatCandidates({ runId, compiled, scopeIds }) {
  const ff = compiled.formatFilter;
  if (ff.mode === 'off' || !ff.set.size) return 0;
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  const scope = scopeWhere(scopeIds, 'r');
  while (true) {
    if (!(await shouldContinue(runId, 'running'))) return examined;
    const [rows] = await pool.query(
      `SELECT r.id, r.source_id, r.file_name
         FROM resources r
        WHERE r.is_deleted = 0 ${scope.sql} AND r.id > ?
        ORDER BY r.id ASC
        LIMIT ?`,
      [...scope.params, lastId, BATCH_SCAN]
    );
    if (!rows.length) break;
    lastId = Number(rows[rows.length - 1].id);
    examined += rows.length;

    const candidates = [];
    for (const row of rows) {
      const ext = getExt(row.file_name);
      const inSet = ff.set.has(ext);
      const kill = ff.mode === 'whitelist' ? !inSet : inSet;
      if (kill) {
        candidates.push({
          run_id: runId,
          resource_id: row.id,
          reason: 'format',
          source_id: row.source_id,
          file_name: row.file_name,
          ext
        });
      }
    }
    await insertCandidates(candidates);
    if (Date.now() - lastReportAt > PROGRESS_FLUSH_MS) {
      lastReportAt = Date.now();
      await progress(runId, examined, lastId);
    }
  }
  await progress(runId, examined, lastId);
  return examined;
}

async function insertDedupeKeys(rows) {
  if (!rows.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_WRITE) {
    const chunk = rows.slice(i, i + BATCH_WRITE);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
    const params = [];
    for (const k of chunk) {
      params.push(
        k.run_id,
        k.resource_id,
        k.source_id,
        String(k.group_key || '').slice(0, 255),
        Number(k.score) || 0,
        String(k.file_name || '').slice(0, 500),
        String(k.ext || '').slice(0, 20)
      );
    }
    const [r] = await pool.query(
      `INSERT INTO cleanup_dedupe_keys
        (run_id, resource_id, source_id, group_key, score, file_name, ext)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE group_key=VALUES(group_key), score=VALUES(score), file_name=VALUES(file_name), ext=VALUES(ext)`,
      params
    );
    inserted += r.affectedRows || 0;
  }
  return inserted;
}

async function generateDedupeCandidates({ runId, compiled, scopeIds, crossSource }) {
  let lastId = 0;
  let examined = 0;
  let lastReportAt = 0;
  const scope = scopeWhere(scopeIds, 'r');
  while (true) {
    if (!(await shouldContinue(runId, 'running'))) return examined;
    const [rows] = await pool.query(
      `SELECT r.id, r.source_id, r.file_name, r.file_type
         FROM resources r
        WHERE r.is_deleted = 0 ${scope.sql} AND r.id > ?
        ORDER BY r.id ASC
        LIMIT ?`,
      [...scope.params, lastId, BATCH_SCAN]
    );
    if (!rows.length) break;
    lastId = Number(rows[rows.length - 1].id);
    examined += rows.length;

    const keys = [];
    for (const row of rows) {
      if (!compiled.qualifies(row.file_name)) continue;
      const key = compiled.extractKey(row.file_name);
      if (!key) continue;
      keys.push({
        run_id: runId,
        resource_id: row.id,
        source_id: row.source_id,
        group_key: (crossSource ? '' : `s${row.source_id}|`) + key,
        score: compiled.score(row.file_name, row.file_type),
        file_name: row.file_name,
        ext: getExt(row.file_name)
      });
    }
    await insertDedupeKeys(keys);
    if (Date.now() - lastReportAt > PROGRESS_FLUSH_MS) {
      lastReportAt = Date.now();
      await progress(runId, examined, lastId);
    }
  }
  await progress(runId, examined, lastId);
  await refreshRunCounts(runId, examined);
  await heartbeat(runId, { error_message: '正在生成去重分组...' });
  await insertDedupeLosers(runId, compiled.tieBreaker);
  return examined;
}

async function insertDedupeLosers(runId, tieBreaker) {
  const idOrder = tieBreaker === 'id_asc' ? 'ASC' : 'DESC';
  await deleteRunRows('cleanup_dedupe_groups', runId, { heartbeatMessage: '正在重置去重分组...' });
  await pool.query(
    `INSERT INTO cleanup_dedupe_groups (run_id, group_key, total, processed)
     SELECT run_id, group_key, COUNT(*) AS total, 0
       FROM cleanup_dedupe_keys
      WHERE run_id=?
      GROUP BY run_id, group_key
     HAVING COUNT(*) > 1`,
    [runId]
  );

  while (await shouldContinue(runId, 'running')) {
    const [groups] = await pool.query(
      `SELECT group_key
         FROM cleanup_dedupe_groups
        WHERE run_id=? AND processed=0
        ORDER BY group_key ASC
        LIMIT ?`,
      [runId, GROUP_BATCH]
    );
    if (!groups.length) break;
    const groupKeys = groups.map((g) => g.group_key);
    const [rows] = await pool.query(
      `SELECT resource_id, source_id, group_key, score, file_name, ext
         FROM cleanup_dedupe_keys
        WHERE run_id=? AND group_key IN (?)
        ORDER BY group_key ASC, score DESC, resource_id ${idOrder}`,
      [runId, groupKeys]
    );

    const candidates = [];
    let currentKey = null;
    let winner = null;
    for (const row of rows) {
      if (row.group_key !== currentKey) {
        currentKey = row.group_key;
        winner = row;
        continue;
      }
      candidates.push({
        run_id: runId,
        resource_id: row.resource_id,
        reason: 'dedupe',
        source_id: row.source_id,
        file_name: row.file_name,
        group_key: row.group_key,
        score: row.score,
        ext: row.ext,
        winner_id: winner.resource_id,
        winner_file_name: winner.file_name
      });
    }
    await insertCandidates(candidates);
    await pool.query(
      `UPDATE cleanup_dedupe_groups
          SET processed=1, processed_at=NOW()
        WHERE run_id=? AND group_key IN (?)`,
      [runId, groupKeys]
    );
    await refreshRunCounts(runId);
    await heartbeat(runId, { error_message: `正在生成去重候选：本批 ${candidates.length} 条` });
  }
}

async function progress(runId, examined, lastId) {
  await pool.query(
    'UPDATE cleanup_runs SET total_examined=?, last_scanned_id=?, worker_id=?, worker_heartbeat_at=NOW() WHERE id=?',
    [examined, lastId, WORKER_ID, runId]
  ).catch(() => {});
}

async function refreshRunCounts(runId, totalExamined = null) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(reason IN ('size','format')) AS by_format,
            SUM(reason='dedupe') AS by_dedupe
       FROM cleanup_candidates
      WHERE run_id=? AND status IN ('candidate','applied')`,
    [runId]
  );
  await pool.query(
    `UPDATE cleanup_runs
        SET candidate_total=?, removed_by_format=?, removed_by_dedupe=?${totalExamined == null ? '' : ', total_examined=?'}
      WHERE id=?`,
    totalExamined == null
      ? [Number(row.total || 0), Number(row.by_format || 0), Number(row.by_dedupe || 0), runId]
      : [Number(row.total || 0), Number(row.by_format || 0), Number(row.by_dedupe || 0), Number(totalExamined || 0), runId]
  );
}

async function persistSamplesFromCandidates(runId) {
  await pool.query('DELETE FROM cleanup_run_samples WHERE run_id=?', [runId]).catch(() => {});
  const [rows] = await pool.query(
    `SELECT resource_id, reason, source_id, file_name, group_key, score, ext, winner_id, winner_file_name
       FROM cleanup_candidates
      WHERE run_id=? AND status IN ('candidate','applied')
      ORDER BY FIELD(reason, 'dedupe', 'format', 'size'), resource_id ASC
      LIMIT ?`,
    [runId, SAMPLE_LIMIT]
  );
  if (!rows.length) return;
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
  const params = [];
  rows.forEach((s, idx) => {
    params.push(
      runId,
      idx,
      s.reason,
      s.resource_id,
      s.source_id,
      String(s.file_name || '').slice(0, 500),
      s.group_key ? String(s.group_key).slice(0, 255) : null,
      Number(s.score) || 0,
      s.ext || null,
      s.winner_id || null,
      s.winner_file_name || null
    );
  });
  await pool.query(
    `INSERT INTO cleanup_run_samples
       (run_id, idx, reason, resource_id, source_id, file_name, group_key, score, ext, winner_id, winner_file_name)
     VALUES ${placeholders}`,
    params
  );
}

async function requestPause(runId) {
  const [r] = await pool.query(
    `UPDATE cleanup_runs
        SET status='paused', paused_at=NOW(), worker_id=NULL
      WHERE id=? AND status IN (${activePlaceholders()})`,
    [Number(runId), ...ACTIVE_STATUSES]
  );
  return (r.affectedRows || 0) > 0;
}

async function resumeRun(oldRunId) {
  const [[row]] = await pool.query('SELECT * FROM cleanup_runs WHERE id = ? LIMIT 1', [oldRunId]);
  if (!row) throw new HttpError(404, 'cleanup run not found');
  if (!['paused', 'failed'].includes(row.status)) {
    throw new HttpError(400, 'only paused/failed cleanup runs can be resumed');
  }
  const scopeIds = row.scope_source_ids ? row.scope_source_ids.split(',').map(Number).filter(Boolean) : [];
  const liveTotal = await countLiveResources(scopeIds);
  await pool.query(
    `UPDATE cleanup_runs
        SET status='queued', total_examined=0, candidate_total=0, applied_total=0,
            removed_by_format=0, removed_by_dedupe=0, last_scanned_id=0,
            error_message=NULL, finished_at=NULL, paused_at=NULL,
            worker_id=NULL, worker_heartbeat_at=NULL
      WHERE id=?`,
    [oldRunId]
  );
  return { run_id: Number(oldRunId), total_examined: liveTotal };
}

async function applyRun(runId, { confirmOver = false } = {}) {
  const [[run]] = await pool.query('SELECT * FROM cleanup_runs WHERE id=? LIMIT 1', [runId]);
  if (!run) throw new HttpError(404, 'cleanup run not found');
  if (run.status !== 'review_ready') {
    throw new HttpError(400, 'only review_ready cleanup runs can be applied');
  }
  const [[cnt]] = await pool.query(
    "SELECT COUNT(*) AS total FROM cleanup_candidates WHERE run_id=? AND status='candidate'",
    [runId]
  );
  const total = Number(cnt.total || 0);
  if (!total) {
    await pool.query("UPDATE cleanup_runs SET status='completed', dry_run=0, applied_total=0, finished_at=NOW() WHERE id=?", [runId]);
    return { applied: 0 };
  }
  const liveTotal = Number(run.total_examined || 0) || await countLiveResources(
    run.scope_source_ids ? String(run.scope_source_ids).split(',').map(Number).filter(Boolean) : []
  );
  const settings = await getSettings();
  if (!confirmOver && total > Math.floor(liveTotal * settings.safe_ratio)) {
    const pct = liveTotal ? ((total / liveTotal) * 100).toFixed(1) : '0.0';
    const msg = `SAFETY_THRESHOLD: candidate set would delete ${total} / ${liveTotal} resources (${pct}%), over ${Math.round(settings.safe_ratio * 100)}%`;
    await pool.query("UPDATE cleanup_runs SET error_message=? WHERE id=?", [msg, runId]);
    throw new HttpError(422, msg);
  }

  await pool.query(
    "UPDATE cleanup_runs SET status='apply_queued', dry_run=0, confirm_over=?, error_message=NULL, worker_id=NULL, worker_heartbeat_at=NULL WHERE id=?",
    [confirmOver ? 1 : 0, runId]
  );
  return { applied: Number(run.applied_total || 0), queued: true };
}

async function applyRunNow(runId) {
  const [[run]] = await pool.query('SELECT * FROM cleanup_runs WHERE id=? LIMIT 1', [runId]);
  if (!run) throw new HttpError(404, 'cleanup run not found');
  if (run.status !== 'applying') return { applied: Number(run.applied_total || 0), skipped: true };
  const liveTotal = Number(run.total_examined || 0) || await countLiveResources(
    run.scope_source_ids ? String(run.scope_source_ids).split(',').map(Number).filter(Boolean) : []
  );
  let applied = Number(run.applied_total || 0);
  try {
    while (true) {
      if (!(await shouldContinue(runId, 'applying'))) {
        await pool.query("UPDATE cleanup_runs SET status='paused', applied_total=?, paused_at=NOW(), worker_id=NULL WHERE id=? AND status='paused'", [applied, runId]);
        return { applied, paused: true };
      }
      const [rows] = await pool.query(
        "SELECT resource_id, reason FROM cleanup_candidates WHERE run_id=? AND status='candidate' ORDER BY resource_id ASC LIMIT ?",
        [runId, BATCH_WRITE]
      );
      if (!rows.length) break;
      const ids = rows.map((r) => Number(r.resource_id)).filter(Boolean);
      if (!ids.length) break;
      await pool.query(`UPDATE resources SET is_deleted=1 WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted=0`, ids);
      const placeholders = rows.map(() => '(?, ?, ?)').join(',');
      const params = [];
      for (const row of rows) params.push(runId, row.resource_id, row.reason);
      await pool.query(
        `INSERT IGNORE INTO cleanup_deleted (run_id, resource_id, reason) VALUES ${placeholders}`,
        params
      );
      await pool.query(
        `UPDATE cleanup_candidates SET status='applied', applied_at=NOW()
          WHERE run_id=? AND resource_id IN (${ids.map(() => '?').join(',')})`,
        [runId, ...ids]
      );
      await searchOutbox.enqueueDeletes(ids).catch((err) => {
        console.warn('[cleanup] enqueue search deletes failed:', err.message);
      });
      applied += ids.length;
      await heartbeat(runId, { applied_total: applied, error_message: null });
    }
    await refreshRunCounts(runId, liveTotal);
    await pool.query(
      "UPDATE cleanup_runs SET status='completed', applied_total=?, finished_at=NOW(), worker_id=NULL, worker_heartbeat_at=NULL WHERE id=?",
      [applied, runId]
    );
    return { applied };
  } finally {
  }
}

async function undoRun(runId) {
  const [[run]] = await pool.query('SELECT * FROM cleanup_runs WHERE id = ?', [runId]);
  if (!run) throw new HttpError(404, 'cleanup run not found');
  if (run.dry_run) throw new HttpError(400, 'this run has not deleted resources');
  if (run.status === 'undone') throw new HttpError(400, 'cleanup run already undone');
  await rollbackRun(runId);
  await pool.query("UPDATE cleanup_runs SET status='undone' WHERE id=?", [runId]);
  return { ok: true };
}

async function rollbackRun(runId) {
  let lastId = 0;
  while (true) {
    const [rows] = await pool.query(
      `SELECT resource_id FROM cleanup_deleted WHERE run_id=? AND resource_id > ? ORDER BY resource_id ASC LIMIT ?`,
      [runId, lastId, BATCH_WRITE]
    );
    if (!rows.length) break;
    lastId = Number(rows[rows.length - 1].resource_id);
    const ids = rows.map((x) => Number(x.resource_id)).filter(Boolean);
    if (!ids.length) break;
    await pool.query(`UPDATE resources SET is_deleted=0 WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted=1`, ids);
    await searchOutbox.enqueueUpserts(ids).catch((err) => {
      console.warn('[cleanup] enqueue search restore failed:', err.message);
    });
  }
  await pool.query('DELETE FROM cleanup_deleted WHERE run_id=?', [runId]);
  await pool.query("UPDATE cleanup_candidates SET status='candidate', applied_at=NULL WHERE run_id=? AND status='applied'", [runId]).catch(() => {});
}

async function candidateSummary(runId) {
  const [byReason] = await pool.query(
    `SELECT reason, COUNT(*) AS total
       FROM cleanup_candidates
      WHERE run_id=? AND status IN ('candidate','applied')
      GROUP BY reason ORDER BY total DESC`,
    [runId]
  );
  const [bySource] = await pool.query(
    `SELECT source_id, COUNT(*) AS total
       FROM cleanup_candidates
      WHERE run_id=? AND status IN ('candidate','applied')
      GROUP BY source_id ORDER BY total DESC LIMIT 20`,
    [runId]
  );
  const [byExt] = await pool.query(
    `SELECT COALESCE(NULLIF(ext,''), '(none)') AS ext, COUNT(*) AS total
       FROM cleanup_candidates
      WHERE run_id=? AND status IN ('candidate','applied')
      GROUP BY COALESCE(NULLIF(ext,''), '(none)') ORDER BY total DESC LIMIT 20`,
    [runId]
  );
  return { by_reason: byReason, by_source: bySource, by_ext: byExt };
}

async function listRuns({ limit = 30 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, rule_id, rule_name_snapshot, scope_source_ids, cross_source,
            dry_run, status, total_examined, candidate_total, applied_total,
            removed_by_format, removed_by_dedupe, error_message, started_at, finished_at
       FROM cleanup_runs ORDER BY id DESC LIMIT ?`,
    [Math.min(Number(limit) || 30, 200)]
  );
  return rows;
}

async function getRun(runId) {
  const [[row]] = await pool.query(
    `SELECT id, rule_id, rule_name_snapshot, scope_source_ids, cross_source,
            dry_run, confirm_over, status, total_examined, candidate_total, applied_total,
            removed_by_format, removed_by_dedupe, error_message, started_at, paused_at, finished_at
       FROM cleanup_runs WHERE id = ? LIMIT 1`,
    [runId]
  );
  if (!row) return null;
  const samples = await getRunSamples(runId, 100);
  const displayStatus = row.status;

  let safetyBlocked = false;
  let errMsg = row.error_message || null;
  if (errMsg && errMsg.startsWith('SAFETY_THRESHOLD:')) {
    safetyBlocked = true;
    errMsg = errMsg.replace(/^SAFETY_THRESHOLD:\s*/, '');
  }
  const totalRemoved = Number(row.candidate_total || 0);
  return {
    id: row.id,
    rule_id: row.rule_id,
    rule_name: row.rule_name_snapshot,
    scope_source_ids: row.scope_source_ids,
    cross_source: !!row.cross_source,
    dry_run: !!row.dry_run,
    confirm_over: !!row.confirm_over,
    status: displayStatus,
    is_running: ['queued', 'running', 'apply_queued', 'applying'].includes(displayStatus),
    is_review_ready: displayStatus === 'review_ready',
    safety_blocked: safetyBlocked,
    total_examined: Number(row.total_examined || 0),
    candidate_total: Number(row.candidate_total || 0),
    applied_total: Number(row.applied_total || 0),
    removed_by_format: Number(row.removed_by_format || 0),
    removed_by_dedupe: Number(row.removed_by_dedupe || 0),
    total_removed: totalRemoved,
    error_message: errMsg,
    samples,
    summary: await candidateSummary(runId),
    started_at: row.started_at,
    paused_at: row.paused_at,
    finished_at: row.finished_at
  };
}

async function getLatestRun() {
  const [[row]] = await pool.query('SELECT id FROM cleanup_runs ORDER BY id DESC LIMIT 1');
  return row ? getRun(row.id) : null;
}

async function getRunSamples(runId, limit = 50) {
  const cap = Math.min(Number(limit) || 50, 500);
  const [rows] = await pool.query(
    `SELECT reason, resource_id AS id, source_id, file_name, group_key, score, ext, winner_id, winner_file_name, status
       FROM cleanup_candidates
      WHERE run_id=? AND status IN ('candidate','applied')
      ORDER BY FIELD(reason, 'dedupe', 'format', 'size'), resource_id ASC
      LIMIT ?`,
    [runId, cap]
  );
  if (rows.length) return rows;
  const [fallback] = await pool.query(
    `SELECT idx, reason, resource_id AS id, source_id, file_name, group_key, score, ext, winner_id, winner_file_name
       FROM cleanup_run_samples WHERE run_id = ? ORDER BY idx ASC LIMIT ?`,
    [runId, cap]
  );
  return fallback;
}

async function claimNextWorkerRun() {
  await markStaleWorkerRuns();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [applyRows] = await conn.query(
      "SELECT id FROM cleanup_runs WHERE status='apply_queued' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
    );
    if (applyRows.length) {
      const id = Number(applyRows[0].id);
      await conn.query(
        "UPDATE cleanup_runs SET status='applying', worker_id=?, worker_heartbeat_at=NOW(), started_at=COALESCE(started_at, NOW()), finished_at=NULL, paused_at=NULL WHERE id=?",
        [WORKER_ID, id]
      );
      await conn.commit();
      return { id, type: 'apply' };
    }

    const [generateRows] = await conn.query(
      "SELECT id FROM cleanup_runs WHERE status='queued' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
    );
    if (generateRows.length) {
      const id = Number(generateRows[0].id);
      await conn.query(
        "UPDATE cleanup_runs SET status='running', worker_id=?, worker_heartbeat_at=NOW(), started_at=COALESCE(started_at, NOW()), finished_at=NULL, paused_at=NULL WHERE id=?",
        [WORKER_ID, id]
      );
      await conn.commit();
      return { id, type: 'generate' };
    }

    await conn.commit();
    return null;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function processNextWorkerRun() {
  const job = await claimNextWorkerRun();
  if (!job) return { processed: 0 };
  try {
    if (job.type === 'apply') {
      const r = await applyRunNow(job.id);
      return { processed: 1, type: job.type, run_id: job.id, ...r };
    }

    const [[run]] = await pool.query('SELECT * FROM cleanup_runs WHERE id=? LIMIT 1', [job.id]);
    if (!run) return { processed: 1, type: job.type, run_id: job.id, skipped: true };
    const config = typeof run.config_snapshot === 'string' ? JSON.parse(run.config_snapshot) : run.config_snapshot;
    const scopeIds = run.scope_source_ids ? String(run.scope_source_ids).split(',').map(Number).filter(Boolean) : [];
    const liveTotal = Number(run.total_examined || 0) || await countLiveResources(scopeIds);
    await generateCandidates({
      runId: job.id,
      config,
      scopeIds,
      crossSource: !!run.cross_source,
      liveTotal
    });
    return { processed: 1, type: job.type, run_id: job.id };
  } catch (err) {
    console.error(`[cleanup-worker] run #${job.id} ${job.type} failed:`, err);
    await pool.query(
      "UPDATE cleanup_runs SET status='failed', error_message=?, finished_at=NOW(), worker_id=NULL, worker_heartbeat_at=NULL WHERE id=?",
      [String(err && err.message || err).slice(0, 1000), job.id]
    ).catch(() => {});
    return { processed: 1, failed: 1, type: job.type, run_id: job.id };
  }
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  getSettings,
  updateSettings,
  startCleanup,
  applyRun,
  requestPause,
  resumeRun,
  undoRun,
  listRuns,
  getRun,
  getLatestRun,
  getRunSamples,
  processNextWorkerRun,
  markStaleWorkerRuns
};
