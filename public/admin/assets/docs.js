// 使用文档数据 — 由 dashboard 渲染
window.LRH_DOCS = {
  baseHint: '把下面所有出现的 https://YOUR_HOST 替换为你的资源库域名，例如 https://ku.hstudy.xyz；把 YOUR_API_KEY 替换为后台签发的 lhk_xxx Key。',
  endpoints: [
    {
      key: 'search',
      method: 'GET',
      path: '/api/v1/search',
      title: '搜索资源（仅元数据，不消耗解析资源）',
      desc: '由 Meilisearch 支持，百万级库内一般 5-30ms 返回，支持拼写容错和前缀匹配（如 "pyth" 命中 "python"）。返回字段不含直链，下游拿到 id 后再按需调 link 接口换直链。',
      params: [
        ['q', 'string', '关键词。空字符串或不传 = 返回全部，按 id 倒序'],
        ['page', 'int', '页码，默认 1'],
        ['pageSize', 'int', '每页大小，默认 20，上限 100'],
        ['source_id', 'int', '可选，限定某个蓝奏账号来源']
      ],
      response: `{
  "code": 200,
  "total": 1287,
  "page": 1,
  "page_size": 20,
  "items": [
    {
      "id": 17,
      "source_id": 1,
      "source": "我的蓝奏号",
      "provider": "ilanzou",
      "file_id": "xxxxxxxx",
      "file_name": "Python入门到入土.zip",
      "file_size": "4260",               // 蓝奏原始值（ilanzou 是 KB 数字；老蓝奏可能带单位）
      "file_size_human": "4.16 MB",      // 已格式化，推荐直接展示这个
      "file_type": "zip",
      "file_time": "2026-04-01",
      "has_share_url": true
    }
  ]
}`
    },
    {
      key: 'detail',
      method: 'GET',
      path: '/api/v1/resources/:id',
      title: '查看单个资源详情',
      desc: '通过 id 取一条资源的所有元数据（包含 share_url，但不含直链）。',
      params: [['id', 'int', '资源 id（path 参数）']],
      response: `{
  "code": 200,
  "item": {
    "id": 17,
    "source": "我的蓝奏号",
    "file_name": "Python入门到入土.zip",
    "file_size": "4260",
    "file_size_human": "4.16 MB",
    "share_url": "https://wwz.lanzouw.com/xxxxx",
    "has_password": false
  }
}`
    },
    {
      key: 'link',
      method: 'GET',
      path: '/api/v1/resources/:id/link',
      title: '换取直链（按需调用，会消耗配额）',
      desc: '实时返回下载直链。直链有时效（约 30 分钟），过期请重新调用本接口。同一资源 30 分钟内重复调用会命中服务端缓存（Redis），不会穿透到蓝奏，响应里 cached=true。',
      params: [['id', 'int', '资源 id（path 参数）']],
      response: `{
  "code": 200,
  "file_name": "Python入门到入土.zip",
  "file_size": "4260",
  "file_size_human": "4.16 MB",
  "url": "https://developer-cdn.lanrar.com/file/...",
  "expire_at": 1715600000000,      // 直链预计失效毫秒时间戳
  "cached": false,                 // true = 命中缓存，未穿透蓝奏
  "daily_limit": 5000,
  "used_today": 13,
  "remaining_today": 4987
}`
    },
    {
      key: 'me',
      method: 'GET',
      path: '/api/v1/me',
      title: '查看 Key 自身配额',
      desc: '调试用，返回当前 Key 的名称、配额、累计用量。',
      params: [],
      response: `{
  "code": 200,
  "name": "小说站-生产",
  "key_prefix": "lhk_AbC123",
  "daily_limit": 5000,
  "rate_per_min": 60,
  "used_today": 13,
  "used_total": 8642
}`
    }
  ],
  examples: {
    curl: `# 1. 搜索（仅取元数据，不解析直链）
curl -H "X-Api-Key: YOUR_API_KEY" \\
  "https://YOUR_HOST/api/v1/search?q=python&page=1&pageSize=20"

# 2. 用户在你的网站上点了某条结果，再用它的 id 换直链
curl -H "X-Api-Key: YOUR_API_KEY" \\
  "https://YOUR_HOST/api/v1/resources/17/link"

# 3. 查询自己 Key 的配额
curl -H "X-Api-Key: YOUR_API_KEY" \\
  "https://YOUR_HOST/api/v1/me"`,

    js: `// fetch 示例（Node 18+ / 浏览器）
const HOST = 'https://YOUR_HOST';
const KEY  = 'YOUR_API_KEY';

async function search(q, page = 1) {
  const url = \`\${HOST}/api/v1/search?q=\${encodeURIComponent(q)}&page=\${page}\`;
  const r = await fetch(url, { headers: { 'X-Api-Key': KEY } });
  if (!r.ok) throw new Error('搜索失败 HTTP ' + r.status);
  return r.json();
}

async function getDirectLink(id) {
  const r = await fetch(\`\${HOST}/api/v1/resources/\${id}/link\`, {
    headers: { 'X-Api-Key': KEY }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message);
  return d;
}

// 用户搜 -> 显示列表 -> 点击某条 -> 才换直链
const list = await search('python');
const picked = list.items[0];
const link = await getDirectLink(picked.id);
console.log('直链:', link.url, '过期时间:', new Date(link.expire_at).toLocaleString());`,

    python: `# Python 3.8+
import requests

HOST = 'https://YOUR_HOST'
KEY  = 'YOUR_API_KEY'
H    = {'X-Api-Key': KEY}

def search(q, page=1, page_size=20):
    r = requests.get(f'{HOST}/api/v1/search',
                     headers=H,
                     params={'q': q, 'page': page, 'pageSize': page_size},
                     timeout=10)
    r.raise_for_status()
    return r.json()

def get_link(rid):
    r = requests.get(f'{HOST}/api/v1/resources/{rid}/link',
                     headers=H, timeout=20)
    r.raise_for_status()
    return r.json()

# 用法
results = search('python')
for it in results['items']:
    print(it['id'], it['file_name'], it['file_size_human'])

picked = results['items'][0]
link = get_link(picked['id'])
print('直链:', link['url'])`,

    php: `<?php
// PHP 7.4+
$HOST = 'https://YOUR_HOST';
$KEY  = 'YOUR_API_KEY';

function lrh_get($url, $key) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => 1,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => ['X-Api-Key: ' . $key],
    ]);
    $body = curl_exec($ch);
    if ($body === false) { throw new Exception(curl_error($ch)); }
    return json_decode($body, true);
}

// 1) 搜索
$res = lrh_get($HOST . '/api/v1/search?q=' . urlencode('python'), $KEY);
foreach ($res['items'] as $r) {
    echo $r['id'] . ' ' . $r['file_name'] . ' ' . $r['file_size_human'] . PHP_EOL;
}

// 2) 取直链
$picked = $res['items'][0];
$link = lrh_get($HOST . '/api/v1/resources/' . $picked['id'] . '/link', $KEY);
echo '直链: ' . $link['url'] . PHP_EOL;`
  },
  errors: [
    ['401', '缺少或无效的 X-Api-Key 头'],
    ['404', '资源不存在或已被同步流程标记为删除'],
    ['429', '触发限流：日配额用尽 / 总配额用尽 / 每分钟过快'],
    ['502', '蓝奏侧解析失败：账号被风控、文件被删、或网络异常']
  ],
  notes: [
    '推荐流程：先调 /search 拿元数据列表 → 用户在你的站点点击某条 → 再调 /resources/:id/link 换直链。这样既省配额，也降低被风控的概率。',
    '文件大小优先展示 file_size_human（已带单位）；file_size 是蓝奏原始值，ilanzou 是纯 KB 数字（4260 表示 4260 KB），老版蓝奏可能带单位（如 "12.3 M"）。两个字段都返回，挑一个用即可。',
    '搜索接口由 Meilisearch 驱动，支持拼写容错（pyton→python）和前缀匹配（只输入 "pyt" 就能出结果）。建议在下游做 200-300ms 输入防抖，实现"打字即搜"的体验。',
    '直链有时效（约 30 分钟），不要在数据库长期保存，每次用户点击下载时即时调用。',
    'Key 泄露请立即在后台「API Key」页停用并重新签发，旧 Key 立即失效。',
    '建议下游先实现 200ms~500ms 的随机延迟（多用户并发场景），防止本地 IP 触发蓝奏侧 IP 限流。'
  ]
};
