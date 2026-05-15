const ICON = {
  dashboard: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2 7-7 7 7 2 2M5 10v10a1 1 0 001 1h3m10-11v10a1 1 0 01-1 1h-3m-6 0h6"/></svg>',
  resources: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>',
  sources: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2H5zm4 6l3 3-3 3m5-6l-3 3 3 3"/></svg>',
  apikeys: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 11-4 0 2 2 0 014 0zm2 0a4 4 0 11-8 0 4 4 0 018 0zM3 21l6-6m2 2l3-3m-3 3l3 3"/></svg>',
  cleanup: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16"/></svg>',
  synclogs: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.01M20 20v-5h-.01M5 9a7 7 0 0112 0M19 15a7 7 0 01-12 0"/></svg>',
  calllogs: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>',
  docs: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
};

function getToken() { return localStorage.getItem('lrh_token') || ''; }

function safeJSON(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

// 清理规则的内置模板，左侧弹窗的"模板按钮"用
const CLEANUP_TEMPLATES = {
  empty: {
    qualifier: { name_must_match: '' },
    key_extractor: { lowercase: true, strip_ext: true, strip_separators: true },
    score_rules: [],
    format_score: {},
    tie_breaker: 'id_desc',
    format_filter: { mode: 'off', extensions: [] }
  },
  novel: {
    qualifier: { name_must_match: '(?:作者|著)\\s*[:：]?|[《》]|(完结|全集|全本|精校版?|校对版|番外|典藏版|修订版|未删减版)' },
    key_extractor: {
      lowercase: true, strip_ext: true, strip_brackets: true, strip_author: true,
      strip_keywords: ['完结','全集','全本','精校版?','校对版','番外','插图版','文字版','典藏版','未删减版','修订版','精排版','epub','txt','pdf','mobi','azw3'],
      strip_separators: true, include_author_in_key: true
    },
    score_rules: [
      { pattern: '精校版?|校对版', score: 50 },
      { pattern: '全本|全集|完结', score: 40 },
      { pattern: '典藏版|修订版|未删减版', score: 30 },
      { pattern: '插图版|文字版', score: 10 },
      { pattern: '番外', score: -20 }
    ],
    format_score: { txt: 3, epub: 2, azw3: 1, mobi: 1, pdf: 0 },
    tie_breaker: 'id_desc',
    format_filter: { mode: 'off', extensions: [] }
  },
  exact: {
    qualifier: { name_must_match: '' },
    key_extractor: { lowercase: true, strip_ext: false, strip_separators: false },
    score_rules: [],
    format_score: {},
    tie_breaker: 'id_desc',
    format_filter: { mode: 'off', extensions: [] }
  },
  whitelist: {
    format_filter: {
      mode: 'whitelist',
      extensions: ['zip','rar','7z','tar','gz','pdf','epub','txt','mobi','azw3','apk','exe','msi','dmg','iso','img','mp4','mkv','avi','mov','mp3','flac','wav','png','jpg','jpeg','gif','webp','psd','doc','docx','xls','xlsx','ppt','pptx']
    }
  },
  blacklist: {
    format_filter: {
      mode: 'blacklist',
      extensions: ['url','lnk','tmp','dat','db','log','bak','crdownload','part','!ut']
    }
  }
};

// 格式化蓝奏的文件大小：纯数字按 KB 处理；已带单位则规范化
function formatFileSize(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = s.match(/^([\d.]+)\s*([a-zA-Z]+)/);
  if (m) {
    let unit = m[2].toUpperCase();
    if (/^[KMGT]$/.test(unit)) unit += 'B';
    return m[1] + ' ' + unit;
  }
  const kb = Number(s);
  if (!isFinite(kb) || kb < 0) return s;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = kb, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = v >= 100 ? 0 : (v >= 10 ? 1 : 2);
  return v.toFixed(digits) + ' ' + units[i];
}

async function api(path, options = {}) {
  const opts = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken()
    },
    ...options
  };
  if (options.body && typeof options.body !== 'string') opts.body = JSON.stringify(options.body);

  const timeoutMs = options.timeout || 90000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  opts.signal = ac.signal;

  // 触发全局进度条（通过自定义事件，不依赖 Alpine 实例）
  window.dispatchEvent(new CustomEvent('api:start'));

  let r;
  try {
    r = await fetch('/api/admin' + path, opts);
  } catch (e) {
    clearTimeout(timer);
    window.dispatchEvent(new CustomEvent('api:end'));
    if (e.name === 'AbortError') throw new Error(`请求超时 (${Math.round(timeoutMs/1000)}s)`);
    throw new Error('网络错误: ' + e.message);
  }
  clearTimeout(timer);
  window.dispatchEvent(new CustomEvent('api:end'));

  if (r.status === 401) {
    localStorage.removeItem('lrh_token');
    location.href = '/admin/login.html';
    return;
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(d.message || ('HTTP ' + r.status));
    err.detail = d.detail || '';
    if (d.context) {
      err.detail = (err.detail ? err.detail + '\n\n' : '')
        + 'context: ' + JSON.stringify(d.context, null, 2);
    }
    err.status = r.status;
    throw err;
  }
  return d;
}

function dashboard() {
  return {
    tab: 'dashboard',
    sidebarOpen: false,
    formatSize: formatFileSize,
    currentUser: { username: '-' },
    navs: [
      { key: 'dashboard', label: '仪表盘', desc: '资源库运行总览', icon: ICON.dashboard },
      { key: 'resources', label: '资源管理', desc: '库内所有资源的检索和维护', icon: ICON.resources },
      { key: 'sources',   label: '数据来源', desc: '蓝奏账号、分享链接来源配置', icon: ICON.sources },
      { key: 'apikeys',   label: 'API Key', desc: '对外开放的调用密钥，接入软件站时签发', icon: ICON.apikeys },
      { key: 'cleanup',   label: '数据清理', desc: '扫盘后去重、按格式过滤；可撤销', icon: ICON.cleanup || ICON.apikeys },
      { key: 'synclogs',  label: '同步日志', desc: '每次拉取蓝奏账号的记录', icon: ICON.synclogs },
      { key: 'calllogs',  label: '调用日志', desc: '对外 API v1 的请求记录', icon: ICON.calllogs },
      { key: 'docs',      label: '使用文档', desc: '下游对接调用说明 · 一键复制', icon: ICON.docs }
    ],
    get currentNav() { return this.navs.find(n => n.key === this.tab); },

    stats: {},
    statCards: [
      { key: 'users',        label: '管理员数' },
      { key: 'sources',      label: '数据来源' },
      { key: 'resources',    label: '资源总数' },
      { key: 'api_keys',     label: 'API Key' },
      { key: 'calls_today',  label: '今日调用' },
      { key: 'calls_24h',    label: '24h 调用' }
    ],
    trendDays: [],

    resQuery: '', resPage: 1,
    resList: { items: [], total: 0 },
    sources: [],
    apiKeys: [],
    syncLogs: [],
    callLogs: [],

    busyTasks: [],

    sourceModal: { open: false, title: '', provider: 'ilanzou', loginType: 'account', account: '', passwordText: '', cookieText: '', rootFolderId: '0', maxIndexDepth: 20, remark: '' },
    sourceEditModal: { open: false, id: null, title: '', account: '', passwordText: '', rootFolderId: '0', maxIndexDepth: 20, remark: '', status: 1 },
    // 进度卡：每个源独立的状态快照（由 2s 轮询 GET /sources/:id/sync-status 填充）
    syncStatus: {},          // { [sourceId]: {has_run, status, total_files, total_calls, progress, ...} }
    syncRate: {},            // { [sourceId]: 文件/秒 } 由前端按差分算
    panelDismissed: {},      // { [sourceId]: true } 用户点 × 隐藏掉这条结束态卡片，下次 syncSource 时清掉
    _syncStatusTimers: {},   // { [sourceId]: setInterval handle } 不会被 Alpine 反应式追踪
    keyModal: { open: false, name: '', dailyLimit: 0, totalLimit: 0, ratePerMin: 60, maxResults: 1000, allowedSourceIds: [], remark: '', expireDays: 30, result: '' },
    keyEditModal: { open: false, id: null, name: '', key_prefix: '', dailyLimit: 0, totalLimit: 0, ratePerMin: 60, maxResults: 1000, allowedSourceIds: [], remark: '', expireText: '', addDays: 30, extendMsg: '' },
    sourcesLite: [],  // [{id, title}] 用于"签发/编辑 Key"弹窗里的库勾选
    cleanup: {
      rules: [],
      runs: [],
      busy: false,
      currentRun: null,         // 跑中的 run 数据，2s 轮询更新
      currentRunTimer: null,    // setInterval 句柄
      lastResult: null,
      runForm: { ruleId: 0, scopeSourceIds: [], crossSource: false }
    },
    cleanupRuleModal: { open: false, id: null, name: '', description: '', enabled: true, configText: '', parseError: '' },
    linkModal: { open: false, fileName: '', url: '', expireText: '', cached: false, loading: false, error: '', detail: '' },
    errorModal: { open: false, title: '', message: '', detail: '' },
    batchResolve: { running: false, total: 0, done: 0, success: 0, failed: 0, canceled: false, summary: false, sources: 0 },
    toast: { msg: '', type: '' },

    // 全局进度条：活跃请求计数器，>0 时显示顶部蓝色进度条
    activeReq: 0,
    // 每个 tab 自己的 loading 状态，true = 显示中间转圈
    tabLoading: { resources: false, sources: false, apikeys: false, synclogs: false, calllogs: false, dashboard: false },
    // 搜索防抖计时器
    _searchDebounce: null,
    searchEngine: '', // 'meili' / 'mysql'，搜完后显示
    searchMs: 0,

    docs: window.LRH_DOCS || { endpoints: [], examples: {}, errors: [], notes: [] },
    docTab: 'curl',
    docHost: '',
    docKey: 'YOUR_API_KEY',

    init() {
      const u = localStorage.getItem('lrh_user');
      if (!getToken()) return location.href = '/admin/login.html';
      if (u) try { this.currentUser = JSON.parse(u); } catch (_) {}
      this.docHost = location.protocol + '//' + location.host;

      // 监听全局 api:start / api:end，驱动顶部进度条
      window.addEventListener('api:start', () => { this.activeReq++; });
      window.addEventListener('api:end',   () => { this.activeReq = Math.max(0, this.activeReq - 1); });

      this.loadStats();
      this.$watch('tab', (v) => {
        if (v === 'resources') this.loadResources(1);
        if (v === 'sources') this.loadSources();
        if (v === 'apikeys') this.loadApiKeys();
        if (v === 'synclogs') this.loadSyncLogs();
        if (v === 'calllogs') this.loadCallLogs();
        if (v === 'dashboard') this.loadStats();
        if (v === 'cleanup') { this.loadCleanupRules(); this.loadCleanupRuns(); this.loadSourcesLite(); }
        else { this._stopCleanupPolling(); }
      });
    },

    notify(msg, type = 'info') {
      this.toast = { msg, type };
      setTimeout(() => { this.toast = { msg: '', type: '' }; }, 2800);
    },
    showError(title, err) {
      this.errorModal = {
        open: true,
        title: title || '出错了',
        message: (err && err.message) || String(err) || '未知错误',
        detail: (err && err.detail) || ''
      };
    },
    startTask(label) {
      const id = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      this.busyTasks.push({ id, label, startAt: Date.now() });
      return id;
    },
    endTask(id) {
      this.busyTasks = this.busyTasks.filter((t) => t.id !== id);
    },

    logout() {
      localStorage.removeItem('lrh_token');
      localStorage.removeItem('lrh_user');
      location.href = '/admin/login.html';
    },

    async loadStats() {
      this.tabLoading.dashboard = true;
      try {
        const [s, t] = await Promise.all([api('/stats'), api('/stats/call-trend')]);
        this.stats = s;
        const max = Math.max(1, ...t.items.map(i => Number(i.total)));
        this.trendDays = t.items.map(i => ({
          day: i.day,
          short: i.day.slice(5),
          height: Math.round(Number(i.total) / max * 100)
        }));
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.tabLoading.dashboard = false; }
    },

    onSearchInput() {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => this.loadResources(1), 200);
    },

    async loadResources(page) {
      if (page < 1) return;
      this.resPage = page;
      this.tabLoading.resources = true;
      try {
        const t0 = performance.now();
        const d = await api('/resources?q=' + encodeURIComponent(this.resQuery) + '&page=' + page + '&pageSize=30');
        this.searchMs = Math.round(performance.now() - t0);
        this.searchEngine = d.engine || '';
        const items = (d.items || []).map((r) => ({
          ...r,
          _linkLoading: false,
          _linkOk: undefined,
          _linkError: '',
          _linkMs: 0
        }));
        this.resList = { items, total: d.total || 0, capped: !!d.capped };
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.tabLoading.resources = false; }
    },
    async deleteResource(id) {
      if (!confirm('确认删除该资源？')) return;
      await api('/resources/' + id, { method: 'DELETE' });
      this.notify('已删除');
      this.loadResources(this.resPage);
    },

    async getDirectLink(r) {
      r._linkLoading = true;
      r._linkOk = undefined;
      r._linkError = '';
      this.linkModal = { open: true, fileName: r.file_name, url: '', expireText: '', cached: false, loading: true, error: '', detail: '' };
      const taskId = this.startTask('解析直链: ' + r.file_name);
      const t0 = Date.now();
      try {
        const d = await api('/resources/' + r.id + '/link', { timeout: 60000 });
        const expireMs = Number(d.expire_at || 0);
        const expireText = expireMs
          ? new Date(expireMs).toLocaleString('zh-CN', { hour12: false })
          : '未知';
        this.linkModal = { open: true, fileName: d.file_name || r.file_name, url: d.url, expireText, cached: !!d.cached, loading: false, error: '', detail: '' };
        r._linkOk = true;
        r._linkMs = Date.now() - t0;
      } catch (e) {
        this.linkModal = {
          open: true, fileName: r.file_name, url: '', expireText: '',
          cached: false, loading: false,
          error: e.message || '解析失败',
          detail: e.detail || ''
        };
        r._linkOk = false;
        r._linkError = e.message || '解析失败';
      } finally {
        r._linkLoading = false;
        this.endTask(taskId);
      }
    },
    async copyDirectLink() {
      const url = this.linkModal.url;
      if (!url) return;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(url);
        } else {
          const ta = document.createElement('textarea');
          ta.value = url;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        this.notify('已复制到剪贴板');
      } catch (e) {
        this.notify('复制失败，请手动选择文本', 'error');
      }
    },

    async loadSources() {
      this.tabLoading.sources = true;
      try {
        const d = await api('/sources');
        this.sources = (d.items || []).map((s) => ({ ...s, _syncing: false, _syncMode: '', _checking: false }));
        // 回到这个 tab / 重进页面 / 删完源后自动拉一遍状态，发现 running 的就开轮询
        await this.refreshAllSyncStatus();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.tabLoading.sources = false; }
    },
    openSourceModal() {
      this.sourceModal = { open: true, title: '', provider: 'ilanzou', loginType: 'account', account: '', passwordText: '', cookieText: '', rootFolderId: '0', maxIndexDepth: 20, remark: '' };
    },
    async saveSource() {
      try {
        await api('/sources', { method: 'POST', body: this.sourceModal });
        this.sourceModal.open = false;
        this.notify('已保存');
        this.loadSources();
      } catch (e) { this.showError('保存失败', e); }
    },
    openSourceEditModal(s) {
      this.sourceEditModal = {
        open: true, id: s.id,
        title: s.title || '',
        account: s.account || '',
        passwordText: '',
        rootFolderId: s.root_folder_id || '0',
        maxIndexDepth: Number(s.max_index_depth) || 20,
        remark: s.remark || '',
        status: s.status ? 1 : 0
      };
    },
    async saveSourceEdit() {
      const m = this.sourceEditModal;
      const body = {
        title: m.title,
        rootFolderId: m.rootFolderId,
        maxIndexDepth: m.maxIndexDepth,
        remark: m.remark,
        status: m.status
      };
      if (m.passwordText && m.passwordText.trim()) body.passwordText = m.passwordText;
      try {
        await api('/sources/' + m.id, { method: 'PATCH', body });
        this.sourceEditModal.open = false;
        this.notify('已保存');
        this.loadSources();
      } catch (e) { this.showError('保存失败', e); }
    },
    async syncSource(id, mode) {
      mode = mode || 'incremental';
      const src = this.sources.find((s) => s.id === id);
      if (src) { src._syncing = true; src._syncMode = mode; }
      // 用户开启新一轮，把上一次"已关闭"标记清掉，让进度卡重新显示
      delete this.panelDismissed[id];
      try {
        const d = await api('/sources/' + id + '/sync', { method: 'POST', body: { mode } });
        if (d.run_id) {
          this.refreshSyncStatus(id);
          this.startSyncStatusPolling(id);
          this.notify((mode === 'full' ? '全量' : '增量') + '扫描已启动');
        }
      } catch (e) {
        this.showError((mode === 'full' ? '全量' : '增量') + '同步触发失败', e);
      } finally {
        if (src) { src._syncing = false; src._syncMode = ''; }
      }
    },
    async testSource(id) {
      const src = this.sources.find((s) => s.id === id);
      if (src) src._checking = true;
      const taskId = this.startTask('测试连接: ' + (src ? src.title : '#' + id));
      try {
        const d = await api('/sources/' + id + '/test', { method: 'POST', timeout: 30000 });
        this.notify('连接成功（user_id=' + (d.user_id || '?') + '）');
      } catch (e) {
        this.showError('连接失败', e);
      } finally {
        if (src) src._checking = false;
        this.endTask(taskId);
      }
    },
    async pauseSync(sourceId) {
      const status = this.syncStatus[sourceId];
      if (!status || !status.run_id) return;
      try {
        await api('/sync-runs/' + status.run_id + '/pause', { method: 'POST' });
        this.notify('已发送暂停信号，等待当前页扫完后停止');
        // 立刻刷新一次，UI 反应快
        setTimeout(() => this.refreshSyncStatus(sourceId), 500);
      } catch (e) {
        this.showError('暂停失败', e);
      }
    },
    async resetSyncProgress(sourceId) {
      if (!confirm('重置后该源会从根目录重新扫，已入库的资源不会丢，但本次未跑完的目录进度会丢失。继续？')) return;
      delete this.panelDismissed[sourceId];
      try {
        await api('/sources/' + sourceId + '/sync', { method: 'POST', body: { mode: 'full' } });
        this.notify('已从根目录重新启动扫描');
        this.refreshSyncStatus(sourceId);
        this.startSyncStatusPolling(sourceId);
      } catch (e) {
        this.showError('重置失败', e);
      }
    },
    // 关闭进度卡（仅 UI 状态，不影响数据库 run；下次同步时会自动重新显示）
    dismissSyncPanel(sourceId) {
      this.panelDismissed[sourceId] = true;
    },
    // 重新显示上次扫描详情卡（用户点过 × 之后想再看）
    showSyncPanel(sourceId) {
      delete this.panelDismissed[sourceId];
      this.refreshSyncStatus(sourceId);
    },
    // 兼容旧调用
    async checkSource(id) { return this.testSource(id); },

    // ===== 进度卡：2s 轮询 GET /sources/:id/sync-status =====
    async refreshSyncStatus(sourceId) {
      try {
        const d = await api('/sources/' + sourceId + '/sync-status', { method: 'GET' });
        const prev = this.syncStatus[sourceId];
        // 速率：每次轮询算 (Δfiles / Δseconds)
        if (prev && prev._lastTs) {
          const dt = (Date.now() - prev._lastTs) / 1000;
          const df = (d.total_files || 0) - (prev.total_files || 0);
          if (dt > 0 && df >= 0) {
            const rate = Math.round(df / dt);
            // 平滑：跟之前的速率做个简单滑动平均
            const oldRate = this.syncRate[sourceId] || 0;
            this.syncRate[sourceId] = Math.round(oldRate * 0.5 + rate * 0.5);
          }
        }
        d._lastTs = Date.now();
        this.syncStatus[sourceId] = d;
        // 如果运行结束了就停止轮询，并刷新源列表（last_sync_at 等字段会变）
        if (!d.is_active && this._syncStatusTimers[sourceId]) {
          this.stopSyncStatusPolling(sourceId);
          this.loadSources();
        }
      } catch (_) {
        // 静默失败，下一次再试
      }
    },
    startSyncStatusPolling(sourceId) {
      this.stopSyncStatusPolling(sourceId);
      this._syncStatusTimers[sourceId] = setInterval(() => this.refreshSyncStatus(sourceId), 2000);
    },
    stopSyncStatusPolling(sourceId) {
      if (this._syncStatusTimers[sourceId]) {
        clearInterval(this._syncStatusTimers[sourceId]);
        delete this._syncStatusTimers[sourceId];
      }
    },
    // 进入页面 / loadSources 后调用：找出"当前正跑"的源，开始轮询
    async refreshAllSyncStatus() {
      for (const s of this.sources) {
        await this.refreshSyncStatus(s.id);
        const st = this.syncStatus[s.id];
        if (st && st.is_active) this.startSyncStatusPolling(s.id);
      }
    },
    async deleteSource(id) {
      if (!confirm('确认删除该来源？关联的资源和日志会一并清除')) return;
      await api('/sources/' + id, { method: 'DELETE' });
      this.notify('已删除');
      this.loadSources();
    },

    async batchResolveCurrentPage() {
      const items = this.resList.items || [];
      if (!items.length) { this.notify('本页没有资源', 'error'); return; }

      // 按 source_id 分组：组间并行（多账号轮询），组内串行（单账号信号量天然限制）
      const groups = {};
      for (const r of items) {
        const k = r.source_id || 0;
        (groups[k] = groups[k] || []).push(r);
      }
      const groupCount = Object.keys(groups).length;
      const tasks = Object.values(groups);

      this.batchResolve = {
        running: true,
        total: items.length,
        done: 0,
        success: 0,
        failed: 0,
        canceled: false,
        summary: false,
        sources: groupCount
      };
      const taskId = this.startTask(`批量解析 ${items.length} 条 (${groupCount} 个来源并行)`);

      const runOne = async (r) => {
        if (this.batchResolve.canceled) return;
        r._linkLoading = true;
        r._linkOk = undefined;
        r._linkError = '';
        const t0 = Date.now();
        try {
          await api('/resources/' + r.id + '/link', { timeout: 60000 });
          r._linkOk = true;
          r._linkMs = Date.now() - t0;
          this.batchResolve.success++;
        } catch (e) {
          r._linkOk = false;
          r._linkError = e.message || '解析失败';
          this.batchResolve.failed++;
        } finally {
          r._linkLoading = false;
          this.batchResolve.done++;
        }
      };

      // 每组（账号）一个 worker 串行处理；组间并行；组内由后端 semaphore 再保险
      const workers = tasks.map(async (group) => {
        for (const r of group) {
          if (this.batchResolve.canceled) break;
          await runOne(r);
        }
      });

      try {
        await Promise.all(workers);
        const msg = this.batchResolve.canceled
          ? `已停止（成功 ${this.batchResolve.success}，失败 ${this.batchResolve.failed}）`
          : `解析完成：成功 ${this.batchResolve.success}，失败 ${this.batchResolve.failed}（${groupCount} 个来源并行）`;
        this.notify(msg);
      } finally {
        this.batchResolve.running = false;
        this.batchResolve.summary = true;
        this.endTask(taskId);
      }
    },

    async unlockSource(id) {
      try {
        await api('/sources/' + id + '/unlock-cooldown', { method: 'POST' });
        this.notify('已解除冷却');
        this.loadSources();
      } catch (e) {
        this.showError('解冻失败', e);
      }
    },

    async loadApiKeys() {
      this.tabLoading.apikeys = true;
      try {
        const d = await api('/api-keys');
        this.apiKeys = d.items || [];
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.tabLoading.apikeys = false; }
    },
    openKeyModal() {
      this.keyModal = { open: true, name: '', dailyLimit: 0, totalLimit: 0, ratePerMin: 60, maxResults: 1000, allowedSourceIds: [], remark: '', expireDays: 30, result: '' };
      this.loadSourcesLite();
    },
    closeKeyModal() {
      this.keyModal.open = false;
      if (this.keyModal.result) this.loadApiKeys();
    },
    async saveKey() {
      try {
        const body = {
          ...this.keyModal,
          // 后端按数字数组反解，发空数组等价于"全部库"
          allowedSourceIds: (this.keyModal.allowedSourceIds || []).map((x) => Number(x))
        };
        const d = await api('/api-keys', { method: 'POST', body });
        this.keyModal.result = d.item.plain_key;
        this.notify('已签发');
      } catch (e) { this.showError('签发失败', e); }
    },
    openKeyEditModal(k) {
      let expireText = '';
      if (k.expire_at) {
        const left = this.daysLeft(k.expire_at);
        expireText = String(k.expire_at).slice(0, 16).replace('T', ' ')
          + (left < 0 ? ` · 已过期 ${-left} 天` : ` · 还有 ${left} 天`);
      }
      this.keyEditModal = {
        open: true, id: k.id,
        name: k.name || '',
        key_prefix: k.key_prefix || '',
        dailyLimit: Number(k.daily_limit || 0),
        totalLimit: Number(k.total_limit || 0),
        ratePerMin: Number(k.rate_per_min || 60),
        maxResults: Number(k.max_results || 1000),
        allowedSourceIds: k.allowed_source_ids
          ? String(k.allowed_source_ids).split(',').map((s) => Number(s.trim())).filter(Boolean)
          : [],
        remark: k.remark || '',
        expireText,
        addDays: 30,
        extendMsg: ''
      };
      this.loadSourcesLite();
    },
    async saveKeyEdit() {
      const m = this.keyEditModal;
      const body = {
        name: m.name,
        dailyLimit: m.dailyLimit,
        totalLimit: m.totalLimit,
        ratePerMin: m.ratePerMin,
        maxResults: m.maxResults,
        allowedSourceIds: (m.allowedSourceIds || []).map((x) => Number(x)),
        remark: m.remark
      };
      try {
        await api('/api-keys/' + m.id, { method: 'PATCH', body });
        this.keyEditModal.open = false;
        this.notify('已保存');
        this.loadApiKeys();
      } catch (e) { this.showError('保存失败', e); }
    },
    async loadSourcesLite() {
      // 缓存一下：弹窗反复打开不重复请求
      if (this.sourcesLite && this.sourcesLite.length) return;
      try {
        const d = await api('/sources-lite');
        this.sourcesLite = d.items || [];
      } catch (_) {
        this.sourcesLite = [];
      }
    },
    async doExtend() {
      const m = this.keyEditModal;
      const days = Number(m.addDays) || 0;
      if (days <= 0) { this.notify('天数必须 > 0', 'error'); return; }
      try {
        const r = await api('/api-keys/' + m.id + '/extend', { method: 'POST', body: { days } });
        if (r.expire_at) {
          const newLeft = this.daysLeft(r.expire_at);
          m.expireText = String(r.expire_at).slice(0, 16).replace('T', ' ') + ` · 还有 ${newLeft} 天`;
          m.extendMsg = `已加 ${days} 天`;
          setTimeout(() => { m.extendMsg = ''; }, 3000);
        } else {
          this.notify(r.message || '已处理');
        }
        this.loadApiKeys();
      } catch (e) { this.showError('延长失败', e); }
    },
    daysLeft(expireAt) {
      if (!expireAt) return Infinity;
      const ms = new Date(String(expireAt).replace(' ', 'T')).getTime() - Date.now();
      return Math.ceil(ms / 86400000);
    },
    async toggleKey(id, op) {
      await api('/api-keys/' + id + '/' + op, { method: 'POST' });
      this.notify(op === 'disable' ? '已停用' : '已启用');
      this.loadApiKeys();
    },
    async deleteKey(id) {
      if (!confirm('确认删除该 API Key？')) return;
      await api('/api-keys/' + id, { method: 'DELETE' });
      this.notify('已删除');
      this.loadApiKeys();
    },

    async loadSyncLogs() {
      this.tabLoading.synclogs = true;
      try {
        const d = await api('/sync-logs');
        this.syncLogs = d.items || [];
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.tabLoading.synclogs = false; }
    },
    async clearSyncLogs() {
      if (!confirm('确认清空同步日志？')) return;
      await api('/sync-logs', { method: 'DELETE' });
      this.syncLogs = [];
      this.notify('已清空');
    },
    async loadCallLogs() {
      this.tabLoading.calllogs = true;
      try {
        const d = await api('/call-logs');
        this.callLogs = d.items || [];
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.tabLoading.calllogs = false; }
    },

    // ---------- 数据清理 ----------
    async loadCleanupRules() {
      try {
        const d = await api('/cleanup/rules');
        this.cleanup.rules = d.items || [];
      } catch (e) { this.showError('加载规则失败', e); }
    },
    async loadCleanupRuns() {
      try {
        const d = await api('/cleanup/runs');
        this.cleanup.runs = d.items || [];
        // 如果有正在跑的 run（比如刷新页面后），自动恢复轮询
        if (!this.cleanup.currentRunTimer) {
          const running = this.cleanup.runs.find((r) => r.status === 'running');
          if (running) {
            this.cleanup.busy = true;
            this.cleanup.currentRun = {
              id: running.id,
              dry_run: !!running.dry_run,
              status: 'running',
              total_examined: running.total_examined || 0,
              removed_by_format: running.removed_by_format || 0,
              removed_by_dedupe: running.removed_by_dedupe || 0,
              total_removed: (running.removed_by_format || 0) + (running.removed_by_dedupe || 0),
              target_total: 0,
              samples: null
            };
            this._startCleanupPolling(running.id);
          }
        }
      } catch (e) { this.showError('加载历史失败', e); }
    },
    ruleTypeOf(r) {
      const cfg = typeof r.config === 'string' ? safeJSON(r.config) : (r.config || {});
      const ff = cfg.format_filter || {};
      const hasFmt = ff.mode && ff.mode !== 'off' && (ff.extensions || []).length;
      const hasDedupe = (cfg.score_rules && cfg.score_rules.length) || cfg.key_extractor;
      if (hasFmt && hasDedupe) return '混合';
      if (hasFmt) return '格式过滤';
      if (hasDedupe) return '去重';
      return '空';
    },
    durationOf(run) {
      if (!run.started_at || !run.finished_at) return '-';
      const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      return Math.floor(ms / 60000) + 'm' + Math.floor((ms % 60000) / 1000) + 's';
    },
    openCleanupRuleModal(r) {
      if (r) {
        const cfg = typeof r.config === 'string' ? r.config : JSON.stringify(r.config, null, 2);
        this.cleanupRuleModal = {
          open: true, id: r.id, name: r.name, description: r.description || '',
          enabled: !!r.enabled,
          configText: typeof r.config === 'string' ? JSON.stringify(JSON.parse(r.config), null, 2) : JSON.stringify(r.config, null, 2),
          parseError: ''
        };
      } else {
        this.cleanupRuleModal = {
          open: true, id: null, name: '', description: '', enabled: true,
          configText: JSON.stringify(CLEANUP_TEMPLATES.empty, null, 2),
          parseError: ''
        };
      }
    },
    loadCleanupTemplate(key) {
      const tpl = CLEANUP_TEMPLATES[key] || CLEANUP_TEMPLATES.empty;
      this.cleanupRuleModal.configText = JSON.stringify(tpl, null, 2);
      this.cleanupRuleModal.parseError = '';
    },
    async saveCleanupRule() {
      let config;
      try { config = JSON.parse(this.cleanupRuleModal.configText); }
      catch (e) { this.cleanupRuleModal.parseError = 'JSON 解析失败：' + e.message; return; }
      this.cleanupRuleModal.parseError = '';
      const m = this.cleanupRuleModal;
      if (!m.name) { this.notify('名称必填', 'error'); return; }
      try {
        const body = { name: m.name, description: m.description, config, enabled: m.enabled ? 1 : 0 };
        if (m.id) await api('/cleanup/rules/' + m.id, { method: 'PATCH', body });
        else      await api('/cleanup/rules', { method: 'POST', body });
        this.cleanupRuleModal.open = false;
        this.notify('已保存');
        this.loadCleanupRules();
      } catch (e) { this.showError('保存失败', e); }
    },
    async duplicateCleanupRule(r) {
      try {
        const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : r.config;
        await api('/cleanup/rules', { method: 'POST', body: {
          name: r.name + ' 副本', description: r.description, config: cfg, enabled: 0
        }});
        this.notify('已复制');
        this.loadCleanupRules();
      } catch (e) { this.showError('复制失败', e); }
    },
    async deleteCleanupRule(r) {
      if (!confirm('删除规则：' + r.name + ' ？历史运行记录会保留。')) return;
      try {
        await api('/cleanup/rules/' + r.id, { method: 'DELETE' });
        this.notify('已删除');
        this.loadCleanupRules();
      } catch (e) { this.showError('删除失败', e); }
    },
    async runCleanupDry() { return this._startCleanup(true); },
    async runCleanupApply() {
      if (!confirm('立即执行会软删除匹配的资源（可一键撤销）。继续？')) return;
      return this._startCleanup(false);
    },
    async _startCleanup(dryRun) {
      const f = this.cleanup.runForm;
      this.cleanup.busy = true;
      this.cleanup.lastResult = null;
      this.cleanup.currentRun = null;
      try {
        // 启动 → 立即返回 run_id（不等扫描完）
        const d = await api('/cleanup/run', { method: 'POST', body: {
          ruleId: f.ruleId,
          scopeSourceIds: f.scopeSourceIds,
          crossSource: f.crossSource,
          dryRun
        }});
        // 进入轮询模式
        this.cleanup.currentRun = {
          id: d.run_id,
          dry_run: dryRun,
          status: 'running',
          total_examined: 0,
          removed_by_format: 0,
          removed_by_dedupe: 0,
          total_removed: 0,
          target_total: d.total_examined || 0,
          samples: null
        };
        this._startCleanupPolling(d.run_id);
      } catch (e) {
        this.cleanup.busy = false;
        this.showError(dryRun ? '试运行启动失败' : '执行启动失败', e);
      }
    },
    _startCleanupPolling(runId) {
      this._stopCleanupPolling();
      const tick = async () => {
        try {
          const d = await api('/cleanup/runs/' + runId);
          const r = d.item;
          if (!r) return;
          // 把 target_total 保留住（后端 total_examined 跑完才是最终值，跑中是已扫数）
          const target = this.cleanup.currentRun ? this.cleanup.currentRun.target_total : 0;
          this.cleanup.currentRun = { ...r, target_total: target };
          if (r.status !== 'running') {
            this._stopCleanupPolling();
            this.cleanup.busy = false;
            // 跑完了，把结果搬到 lastResult，关闭遮罩
            this.cleanup.lastResult = {
              dry_run: r.dry_run,
              status: r.status,
              total_examined: r.total_examined,
              removed_by_format: r.removed_by_format,
              removed_by_dedupe: r.removed_by_dedupe,
              total_removed: r.total_removed,
              samples: r.samples || [],
              error_message: r.error_message
            };
            this.cleanup.currentRun = null;
            this.loadCleanupRuns();
            if (r.status === 'failed') {
              this.notify(r.error_message || '执行失败', 'error');
            } else {
              this.notify(r.dry_run ? '试运行完成' : ('已执行：删除 ' + r.total_removed + ' 条'));
            }
          }
        } catch (e) {
          // 单次轮询失败不致命，继续轮询；除非 404
          if (e && /404/.test(String(e.message))) {
            this._stopCleanupPolling();
            this.cleanup.busy = false;
            this.cleanup.currentRun = null;
            this.showError('查询任务状态失败', e);
          }
        }
      };
      tick();
      this.cleanup.currentRunTimer = setInterval(tick, 2000);
    },
    _stopCleanupPolling() {
      if (this.cleanup.currentRunTimer) {
        clearInterval(this.cleanup.currentRunTimer);
        this.cleanup.currentRunTimer = null;
      }
    },
    cleanupProgressPct() {
      const c = this.cleanup.currentRun;
      if (!c || !c.target_total) return 0;
      return Math.min(99, Math.floor((c.total_examined / c.target_total) * 100));
    },
    async undoCleanupRun(id) {
      if (!confirm('撤销这次清理（恢复被软删除的资源）？')) return;
      try {
        await api('/cleanup/runs/' + id + '/undo', { method: 'POST' });
        this.notify('已撤销');
        this.loadCleanupRuns();
      } catch (e) { this.showError('撤销失败', e); }
    },

    docExampleText(lang) {
      const raw = (this.docs.examples && this.docs.examples[lang]) || '';
      return raw
        .replace(/YOUR_HOST/g, this.docHost.replace(/^https?:\/\//, ''))
        .replace(/https:\/\/YOUR_HOST/g, this.docHost)
        .replace(/YOUR_API_KEY/g, this.docKey || 'YOUR_API_KEY');
    },
    async copyText(text, label) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        this.notify((label || '内容') + '已复制');
      } catch (e) {
        this.notify('复制失败，请手动选择', 'error');
      }
    },
    buildFullDocText() {
      const d = this.docs;
      const host = this.docHost;
      const key = this.docKey || 'YOUR_API_KEY';
      const lines = [];
      lines.push('# 云逸蓝奏 资源库 API · 接入文档');
      lines.push('');
      lines.push('Host: ' + host);
      lines.push('鉴权: 在每个请求头加 `X-Api-Key: <YOUR_API_KEY>`');
      lines.push('');
      lines.push('## 推荐调用顺序');
      lines.push('1. /search 拿元数据列表（不消耗解析资源）');
      lines.push('2. 用户点击具体某条结果时，再调 /resources/:id/link 换直链');
      lines.push('3. 直链 30 分钟内有效，不要长期缓存到数据库');
      lines.push('');
      lines.push('## 接口列表');
      d.endpoints.forEach((ep) => {
        lines.push('### ' + ep.method + ' ' + ep.path);
        lines.push(ep.title);
        lines.push('');
        if (ep.desc) { lines.push(ep.desc); lines.push(''); }
        if (ep.params && ep.params.length) {
          lines.push('参数：');
          ep.params.forEach(p => lines.push('  - ' + p[0] + ' (' + p[1] + ') ' + p[2]));
          lines.push('');
        }
        lines.push('返回示例：');
        lines.push('```json');
        lines.push(ep.response);
        lines.push('```');
        lines.push('');
      });
      lines.push('## cURL 示例');
      lines.push('```bash');
      lines.push(this.docExampleText('curl'));
      lines.push('```');
      lines.push('');
      lines.push('## JavaScript 示例');
      lines.push('```js');
      lines.push(this.docExampleText('js'));
      lines.push('```');
      lines.push('');
      lines.push('## Python 示例');
      lines.push('```python');
      lines.push(this.docExampleText('python'));
      lines.push('```');
      lines.push('');
      lines.push('## PHP 示例');
      lines.push('```php');
      lines.push(this.docExampleText('php'));
      lines.push('```');
      lines.push('');
      lines.push('## 错误码');
      d.errors.forEach(e => lines.push('  ' + e[0] + ' — ' + e[1]));
      lines.push('');
      lines.push('## 注意事项');
      d.notes.forEach((n, i) => lines.push((i + 1) + '. ' + n));
      return lines.join('\n');
    },
    copyAllDocs() {
      const txt = this.buildFullDocText();
      this.copyText(txt, '完整接入文档');
    }
  };
}
