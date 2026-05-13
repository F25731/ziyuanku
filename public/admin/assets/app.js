const ICON = {
  dashboard: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2 7-7 7 7 2 2M5 10v10a1 1 0 001 1h3m10-11v10a1 1 0 01-1 1h-3m-6 0h6"/></svg>',
  resources: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>',
  sources: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2H5zm4 6l3 3-3 3m5-6l-3 3 3 3"/></svg>',
  apikeys: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 11-4 0 2 2 0 014 0zm2 0a4 4 0 11-8 0 4 4 0 018 0zM3 21l6-6m2 2l3-3m-3 3l3 3"/></svg>',
  synclogs: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.01M20 20v-5h-.01M5 9a7 7 0 0112 0M19 15a7 7 0 01-12 0"/></svg>',
  calllogs: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>'
};

function getToken() { return localStorage.getItem('lrh_token') || ''; }

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
  const r = await fetch('/api/admin' + path, opts);
  if (r.status === 401) {
    localStorage.removeItem('lrh_token');
    location.href = '/admin/login.html';
    return;
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || ('HTTP ' + r.status));
  return d;
}

function dashboard() {
  return {
    tab: 'dashboard',
    currentUser: { username: '-' },
    navs: [
      { key: 'dashboard', label: '仪表盘', desc: '资源库运行总览', icon: ICON.dashboard },
      { key: 'resources', label: '资源管理', desc: '库内所有资源的检索和维护', icon: ICON.resources },
      { key: 'sources',   label: '数据来源', desc: '蓝奏账号、分享链接来源配置', icon: ICON.sources },
      { key: 'apikeys',   label: 'API Key', desc: '对外开放的调用密钥，接入软件站时签发', icon: ICON.apikeys },
      { key: 'synclogs',  label: '同步日志', desc: '每次拉取蓝奏账号的记录', icon: ICON.synclogs },
      { key: 'calllogs',  label: '调用日志', desc: '对外 API v1 的请求记录', icon: ICON.calllogs }
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

    sourceModal: { open: false, title: '', provider: 'ilanzou', loginType: 'account', account: '', passwordText: '', cookieText: '', rootFolderId: '0', remark: '' },
    keyModal: { open: false, name: '', dailyLimit: 0, totalLimit: 0, ratePerMin: 60, remark: '', result: '' },
    toast: { msg: '', type: '' },

    init() {
      const u = localStorage.getItem('lrh_user');
      if (!getToken()) return location.href = '/admin/login.html';
      if (u) try { this.currentUser = JSON.parse(u); } catch (_) {}
      this.loadStats();
      this.$watch('tab', (v) => {
        if (v === 'resources') this.loadResources(1);
        if (v === 'sources') this.loadSources();
        if (v === 'apikeys') this.loadApiKeys();
        if (v === 'synclogs') this.loadSyncLogs();
        if (v === 'calllogs') this.loadCallLogs();
        if (v === 'dashboard') this.loadStats();
      });
    },

    notify(msg, type = 'info') {
      this.toast = { msg, type };
      setTimeout(() => { this.toast = { msg: '', type: '' }; }, 2500);
    },

    logout() {
      localStorage.removeItem('lrh_token');
      localStorage.removeItem('lrh_user');
      location.href = '/admin/login.html';
    },

    async loadStats() {
      try {
        this.stats = await api('/stats');
        const t = await api('/stats/call-trend');
        const max = Math.max(1, ...t.items.map(i => Number(i.total)));
        this.trendDays = t.items.map(i => ({
          day: i.day,
          short: i.day.slice(5),
          height: Math.round(Number(i.total) / max * 100)
        }));
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async loadResources(page) {
      if (page < 1) return;
      this.resPage = page;
      try {
        const d = await api('/resources?q=' + encodeURIComponent(this.resQuery) + '&page=' + page + '&pageSize=30');
        this.resList = { items: d.items || [], total: d.total || 0 };
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async deleteResource(id) {
      if (!confirm('确认删除该资源？')) return;
      await api('/resources/' + id, { method: 'DELETE' });
      this.notify('已删除');
      this.loadResources(this.resPage);
    },

    async loadSources() {
      const d = await api('/sources');
      this.sources = d.items || [];
    },
    openSourceModal() {
      this.sourceModal = { open: true, title: '', provider: 'ilanzou', loginType: 'account', account: '', passwordText: '', cookieText: '', rootFolderId: '0', remark: '' };
    },
    async saveSource() {
      try {
        await api('/sources', { method: 'POST', body: this.sourceModal });
        this.sourceModal.open = false;
        this.notify('已保存');
        this.loadSources();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async syncSource(id) {
      this.notify('同步中，可能需要几十秒...');
      try {
        const d = await api('/sources/' + id + '/sync', { method: 'POST' });
        this.notify('同步完成，共 ' + d.total + ' 个文件');
        this.loadSources();
      } catch (e) { this.notify('同步失败: ' + e.message, 'error'); }
    },
    async checkSource(id) {
      try {
        const d = await api('/sources/' + id + '/check', { method: 'POST' });
        this.notify('检测通过，共 ' + d.total + ' 个文件');
      } catch (e) { this.notify('检测失败: ' + e.message, 'error'); }
    },
    async deleteSource(id) {
      if (!confirm('确认删除该来源？关联的资源和日志会一并清除')) return;
      await api('/sources/' + id, { method: 'DELETE' });
      this.notify('已删除');
      this.loadSources();
    },

    async loadApiKeys() {
      const d = await api('/api-keys');
      this.apiKeys = d.items || [];
    },
    openKeyModal() {
      this.keyModal = { open: true, name: '', dailyLimit: 0, totalLimit: 0, ratePerMin: 60, remark: '', result: '' };
    },
    closeKeyModal() {
      this.keyModal.open = false;
      if (this.keyModal.result) this.loadApiKeys();
    },
    async saveKey() {
      try {
        const d = await api('/api-keys', { method: 'POST', body: this.keyModal });
        this.keyModal.result = d.item.plain_key;
        this.notify('已签发');
      } catch (e) { this.notify(e.message, 'error'); }
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
      const d = await api('/sync-logs');
      this.syncLogs = d.items || [];
    },
    async clearSyncLogs() {
      if (!confirm('确认清空同步日志？')) return;
      await api('/sync-logs', { method: 'DELETE' });
      this.syncLogs = [];
      this.notify('已清空');
    },
    async loadCallLogs() {
      const d = await api('/call-logs');
      this.callLogs = d.items || [];
    }
  };
}
