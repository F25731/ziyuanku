// 蓝奏优享 (ilanzou) 官方 web API 直连客户端
// 完全照搬 OpenList drivers/ilanzou 的签名 / 接口路径，绕开第三方 SDK
// 关键参数：uuid + devType=6 + devCode=uuid + devModel=chrome + devVersion=125
//          + timestamp(AES加密的毫秒数) + appToken
// 直链接口：/unproved/file/redirect?... + downloadId(AES) + auth(AES) → 302 Location

const crypto = require('crypto');
const axios = require('axios');

const BASE = 'https://api.ilanzou.com';
const SITE = 'https://www.ilanzou.com';
const SECRET = Buffer.from('lanZouY-disk-app', 'utf8'); // 16 字节，AES-128
const DEV_VERSION = '125';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// AES-128-ECB + PKCS7 padding，输出 hex
function aesHex(plaintext) {
  const cipher = crypto.createCipheriv('aes-128-ecb', SECRET, null);
  const enc = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  return enc.toString('hex');
}

function nowTs() {
  const ms = Date.now();
  return { ms, msStr: String(ms), tsAes: aesHex(String(ms)) };
}

function buildCommonParams(uuid, appToken) {
  const { tsAes } = nowTs();
  const params = {
    uuid,
    devType: '6',
    devCode: uuid,
    devModel: 'chrome',
    devVersion: DEV_VERSION,
    appVersion: '',
    timestamp: tsAes
  };
  if (appToken) params.appToken = appToken;
  params.extra = '2';
  return params;
}

function commonHeaders() {
  return {
    'User-Agent': UA,
    'Origin': SITE,
    'Referer': SITE + '/',
    'Accept-Encoding': 'gzip',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US,en;q=0.8'
  };
}

// 进程内 client 缓存：account → { uuid, appToken, userId, expireAt }
const CLIENT_TTL_MS = 30 * 60 * 1000;
const clientCache = new Map();

async function http(method, pathname, { params, body, headers, maxRedirects, validateStatus, timeout } = {}) {
  return axios.request({
    method,
    url: BASE + pathname,
    params,
    data: body,
    headers: { ...commonHeaders(), ...(headers || {}) },
    timeout: timeout || 20000,
    maxRedirects: maxRedirects == null ? 5 : maxRedirects,
    validateStatus: validateStatus || ((s) => s >= 200 && s < 400)
  });
}

async function fetchUuid() {
  const params = buildCommonParams('', '');
  const resp = await http('GET', '/unproved/getUuid', { params });
  const uuid = resp.data && resp.data.uuid;
  if (!uuid) throw new Error('getUuid 返回为空: ' + JSON.stringify(resp.data));
  return String(uuid);
}

async function loginRaw(uuid, account, password) {
  const params = buildCommonParams(uuid, '');
  const resp = await http('POST', '/unproved/login', {
    params,
    body: { loginName: account, loginPwd: password },
    headers: { 'Content-Type': 'application/json' }
  });
  const code = resp.data && resp.data.code;
  if (code !== 200) {
    const msg = (resp.data && (resp.data.msg || resp.data.message)) || JSON.stringify(resp.data);
    throw new Error('ilanzou login 失败: ' + msg);
  }
  const token = resp.data && resp.data.data && resp.data.data.appToken;
  if (!token) throw new Error('login 响应缺少 appToken: ' + JSON.stringify(resp.data));
  return String(token);
}

async function fetchUserId(uuid, appToken) {
  const params = buildCommonParams(uuid, appToken);
  const resp = await http('GET', '/proved/user/account/map', { params });
  const userId = resp.data && resp.data.map && resp.data.map.userId;
  if (!userId) throw new Error('user/account/map 缺少 userId: ' + JSON.stringify(resp.data));
  return String(userId);
}

// 拿到（或复用）一个登录态 client
async function getClient(account, password) {
  if (!account || !password) throw new Error('缺少 account/password');
  const now = Date.now();
  const cached = clientCache.get(account);
  if (cached && cached.expireAt > now) return cached;

  const uuid = await fetchUuid();
  const appToken = await loginRaw(uuid, account, password);
  const userId = await fetchUserId(uuid, appToken);
  const ctx = { account, uuid, appToken, userId, expireAt: now + CLIENT_TTL_MS };
  clientCache.set(account, ctx);
  return ctx;
}

function invalidateClient(account) {
  clientCache.delete(account);
}

// 取直链：/unproved/file/redirect?...&downloadId=AES(fileId|userId)&auth=AES(fileId|ts)
// 不跟随 302，直接读 Location 头返回
async function getDownloadUrl(account, password, fileId) {
  if (!fileId) throw new Error('file_id 为空');
  let ctx = await getClient(account, password);

  const tryOnce = async () => {
    const { ms, tsAes } = nowTs();
    const params = {
      uuid: ctx.uuid,
      devType: '6',
      devCode: ctx.uuid,
      devModel: 'chrome',
      devVersion: DEV_VERSION,
      appVersion: '',
      timestamp: tsAes,
      appToken: ctx.appToken,
      enable: '0',
      downloadId: aesHex(`${fileId}|${ctx.userId}`),
      auth: aesHex(`${fileId}|${ms}`)
    };
    const resp = await http('GET', '/unproved/file/redirect', {
      params,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400
    });
    if (resp.status === 302 || resp.status === 301) {
      const loc = resp.headers && (resp.headers.location || resp.headers.Location);
      if (loc) return String(loc);
    }
    const code = resp.data && resp.data.code;
    const msg = (resp.data && (resp.data.msg || resp.data.message)) || JSON.stringify(resp.data || {});
    const err = new Error(`file/redirect 异常 status=${resp.status} code=${code} msg=${msg}`);
    err.code = code;
    throw err;
  };

  try {
    return await tryOnce();
  } catch (err) {
    // token 失效（code -1 / -2）→ 重新登录后再试一次
    if (err.code === -1 || err.code === -2 || /token|appToken|未登录/i.test(err.message || '')) {
      invalidateClient(account);
      ctx = await getClient(account, password);
      return await tryOnce();
    }
    throw err;
  }
}

// 列目录：/proved/record/file/list?offset=N&limit=60&folderId=X&type=0
// offset 是页号语义（从 1 开始），与 OpenList 一致
// 单次返回最多 60 条；翻页直到 resp.offset >= resp.totalPage
async function listFolderPage(account, password, folderId, offset = 1, limit = 60) {
  let ctx = await getClient(account, password);

  const tryOnce = async () => {
    const params = {
      ...buildCommonParams(ctx.uuid, ctx.appToken),
      offset: String(offset),
      limit: String(limit),
      folderId: String(folderId),
      type: '0'
    };
    const resp = await http('GET', '/proved/record/file/list', { params });
    const code = resp.data && resp.data.code;
    if (code !== 200) {
      const msg = (resp.data && (resp.data.msg || resp.data.message)) || JSON.stringify(resp.data || {});
      const err = new Error(`record/file/list code=${code} msg=${msg}`);
      err.code = code;
      err.raw = resp.data;
      throw err;
    }
    return resp.data; // { code, msg, total, offset, totalPage, limit, list:[...] }
  };

  try {
    return await tryOnce();
  } catch (err) {
    if (err.code === -1 || err.code === -2) {
      invalidateClient(account);
      ctx = await getClient(account, password);
      return await tryOnce();
    }
    throw err;
  }
}

// 列出某目录下所有页（按 OpenList 语义：offset 从 1 开始递增到 totalPage）
async function listFolderAll(account, password, folderId, { limit = 60, onPage } = {}) {
  const all = [];
  let offset = 1;
  while (true) {
    const resp = await listFolderPage(account, password, folderId, offset, limit);
    const list = Array.isArray(resp.list) ? resp.list : [];
    all.push(...list);
    if (typeof onPage === 'function') {
      try { await onPage({ folderId, offset, totalPage: resp.totalPage, list }); } catch (_) {}
    }
    const totalPage = Number(resp.totalPage || 0);
    if (!list.length) break;
    if (totalPage > 0 && offset >= totalPage) break;
    offset++;
  }
  return all;
}

module.exports = {
  aesHex,
  getClient,
  invalidateClient,
  getDownloadUrl,
  listFolderPage,
  listFolderAll
};
