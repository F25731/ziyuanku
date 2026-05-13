const axios = require('axios');
const cheerio = require('cheerio');
const { LanZouYClient } = require('@netdrive-sdk/ilanzou');
const { getRedis } = require('../config/redis');

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LANZOU_HOSTS = ['lanzou', 'lanzoux', 'lanzoui', 'lanzouw', 'lanzouj', 'lanzouf', 'lanzoup', 'lanzouq', 'lanzouv', 'lanzouy', 'woozooo'];

function isLanzouPublicUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return LANZOU_HOSTS.some((h) => u.hostname.includes(h));
  } catch (_) { return false; }
}

function cacheKey(resourceId) { return `link:cache:${resourceId}`; }

async function getCached(resourceId) {
  try {
    const r = getRedis();
    const raw = await r.get(cacheKey(resourceId));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && obj.url && obj.expireAt && obj.expireAt > Date.now()) return obj;
    return null;
  } catch (_) { return null; }
}

async function setCached(resourceId, url, ttlSec) {
  try {
    const r = getRedis();
    const expireAt = Date.now() + ttlSec * 1000;
    await r.setex(cacheKey(resourceId), ttlSec, JSON.stringify({ url, expireAt }));
    return expireAt;
  } catch (_) { return Date.now() + ttlSec * 1000; }
}

function asString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.url) return String(v.url);
  return String(v);
}

// -------- 方式 A：ilanzou (新版) 账号模式 --------
async function resolveByIlanzouAccount(resource) {
  if (!resource.source_account || !resource.source_password) {
    throw new Error('账号模式缺少账号/密码');
  }
  if (!resource.file_id) {
    throw new Error('file_id 为空，无法通过账号模式解析');
  }
  console.log(`[resolve] account-mode fileId=${resource.file_id} account=${resource.source_account}`);

  const client = new LanZouYClient({
    username: resource.source_account,
    password: resource.source_password
  });
  client.config.apiUrl = 'https://apis.ilanzou.com';
  client.client = client.client.extend({ prefixUrl: client.config.apiUrl });

  let loginRes;
  try {
    loginRes = await client.login();
  } catch (err) {
    throw new Error('ilanzou 登录请求异常: ' + (err.message || err));
  }
  if (!loginRes || loginRes.code !== 200) {
    throw new Error('ilanzou 登录失败: ' + JSON.stringify(loginRes));
  }

  // 优先：directly download with redirect=true
  let direct;
  try {
    direct = await client.downloadFile(String(resource.file_id), true);
  } catch (err) {
    throw new Error('downloadFile 调用异常: ' + (err.message || err));
  }
  const url = asString(direct);
  if (url && /^https?:\/\//.test(url)) return url.trim();
  throw new Error('downloadFile 未返回 URL，原始: ' + JSON.stringify(direct));
}

// -------- 方式 B：公开 share_url 解析（lanzou.com / lanzoux / ...）--------
async function resolveByPublicShareUrl(shareUrl, password) {
  console.log(`[resolve] public-mode shareUrl=${shareUrl}`);
  let pageResp;
  try {
    pageResp = await axios.get(shareUrl, {
      headers: { 'User-Agent': UA_PC, Referer: shareUrl },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });
  } catch (err) {
    throw new Error('打开分享页失败: ' + (err.message || err));
  }
  const pageHtml = pageResp.data || '';
  const origin = new URL(shareUrl).origin;

  if (password && /pwd|pass|访问密码|请输入密码/.test(pageHtml) && /<form/i.test(pageHtml)) {
    const actionMatch = pageHtml.match(/url\s*:\s*['"](\/ajaxm\.php[^'"]*)['"]/i);
    const action = actionMatch ? actionMatch[1] : '/ajaxm.php';
    const signMatch = pageHtml.match(/['"]sign['"]\s*:\s*['"]([^'"]+)['"]/);
    const sign = signMatch ? signMatch[1] : '';
    const resp = await axios.post(origin + action, new URLSearchParams({
      action: 'downprocess', sign, p: password
    }).toString(), {
      headers: {
        'User-Agent': UA_PC, Referer: shareUrl,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded'
      }, timeout: 15000
    });
    if (resp.data && resp.data.zt === 1 && resp.data.dom && resp.data.url) {
      return await followRedirect(resp.data.dom + '/file/' + resp.data.url, shareUrl);
    }
    throw new Error('密码页解析失败: ' + JSON.stringify(resp.data));
  }

  const $ = cheerio.load(pageHtml);
  let iframeSrc = $('iframe').attr('src');
  if (!iframeSrc) {
    const m = pageHtml.match(/<iframe[^>]+src\s*=\s*['"]([^'"]+)['"]/i);
    iframeSrc = m ? m[1] : null;
  }
  if (!iframeSrc) throw new Error('未找到 iframe，分享页结构异常');

  const iframeUrl = new URL(iframeSrc, origin).href;
  const iframeResp = await axios.get(iframeUrl, {
    headers: { 'User-Agent': UA_PC, Referer: shareUrl }, timeout: 15000
  });
  const iframeHtml = iframeResp.data || '';
  const signMatch = iframeHtml.match(/['"]sign['"]\s*:\s*['"]([^'"]+)['"]/)
    || iframeHtml.match(/var\s+(?:wsk_sign|sasign|wsign|sign)\s*=\s*['"]([^'"]+)['"]/);
  const sign = signMatch ? (signMatch[1] || signMatch[2]) : '';
  if (!sign) throw new Error('iframe 页面未找到 sign 字段');

  const ajaxResp = await axios.post(origin + '/ajaxm.php', new URLSearchParams({
    action: 'downprocess', sign, ves: 1
  }).toString(), {
    headers: {
      'User-Agent': UA_PC, Referer: iframeUrl,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    }, timeout: 15000
  });
  if (ajaxResp.data && ajaxResp.data.zt === 1 && ajaxResp.data.dom && ajaxResp.data.url) {
    return await followRedirect(ajaxResp.data.dom + '/file/' + ajaxResp.data.url, shareUrl);
  }
  throw new Error('ajaxm 返回异常: ' + JSON.stringify(ajaxResp.data));
}

async function followRedirect(url, referer) {
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA_PC, Referer: referer, Accept: '*/*' },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      timeout: 15000
    });
    const loc = resp.headers && resp.headers.location;
    if (loc) return loc;
    return url;
  } catch (err) {
    if (err.response && err.response.headers && err.response.headers.location) {
      return err.response.headers.location;
    }
    return url;
  }
}

// -------- 对外：按资源选择解析方式 --------
async function resolve(resource) {
  if (!resource) throw new Error('资源不存在');
  const ttl = Number(process.env.LINK_CACHE_TTL || 1800);

  const cached = await getCached(resource.id);
  if (cached) return { url: cached.url, expire_at: cached.expireAt, cached: true };

  const errors = [];
  let url = '';

  const isAccount = resource.source_provider === 'ilanzou' && resource.source_login_type === 'account';
  if (isAccount) {
    try {
      url = await resolveByIlanzouAccount(resource);
    } catch (err) {
      errors.push('账号模式: ' + (err.message || err));
      console.error('[resolve] account-mode failed:', err.message || err);
    }
  }

  if (!url && isLanzouPublicUrl(resource.share_url)) {
    try {
      url = await resolveByPublicShareUrl(resource.share_url, resource.share_pwd);
    } catch (err) {
      errors.push('公开链接模式: ' + (err.message || err));
      console.error('[resolve] public-mode failed:', err.message || err);
    }
  }

  if (!url) {
    const reason = errors.length ? errors.join(' | ') : '资源既无可用账号也无可解析的 share_url';
    throw new Error(reason);
  }

  const expireAt = await setCached(resource.id, url, ttl);
  return { url, expire_at: expireAt, cached: false };
}

module.exports = { resolve, isLanzouPublicUrl };
