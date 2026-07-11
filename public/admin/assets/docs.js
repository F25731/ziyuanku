// 使用文档数据 — 由 dashboard 渲染
window.LRH_DOCS = {
  baseHint: '把下面所有出现的 https://YOUR_HOST 替换为你的资源库域名，例如 https://ku.hstudy.xyz；把 YOUR_API_KEY 替换为后台签发的 lhk_xxx Key。',
  endpoints: [
    {
      key: 'search_stream',
      method: 'GET',
      path: '/api/v1/search/stream',
      title: '流式搜索资源（SSE，一条条返回）',
      desc: '适合下游网站做“结果逐条出现”的体验。服务端发送 text/event-stream，事件包括 meta、item、done、error。接口只返回元数据，不消耗 /link 配额。浏览器直连时推荐用 fetch + ReadableStream，这样可以继续放 X-Api-Key 请求头。',
      params: [
        ['q', 'string', '关键词。受 SEARCH_MIN_QUERY_LEN 保护，默认至少 2 个字符'],
        ['pageSize', 'int', '每批查询大小，默认 20，上限 100'],
        ['limit', 'int', '本次流最多推送多少条，默认等于 pageSize，上限 1000，并受 Key 的 max_results 限制'],
        ['cursor', 'string', '可选，从上次 done.next_cursor 继续'],
        ['source_id', 'int', '可选，限定某个来源']
      ],
      response: `event: meta
data: {"code":200,"message":"stream started","page_size":20,"limit":100,"cap_limit":1000}

event: item
data: {"index":1,"item":{"id":17,"file_name":"Python入门.zip","file_size_human":"4.16 MB"}}

event: done
data: {"code":200,"message":"ok","count":20,"next_cursor":"...","has_more":true}`
    },
    {
      key: 'search',
      method: 'GET',
      path: '/api/v1/search',
      title: '搜索资源（仅元数据，不消耗配额）',
      desc: '启用 Meilisearch 时走轻量搜索索引（只存 id/file_name/source_id/file_type），否则回落 MySQL FULLTEXT。返回字段不含直链，下游拿到 id 后再按需调 link 接口换直链。本接口不消耗 Key 的日/总配额。',
      params: [
        ['q', 'string', '关键词。空字符串或不传 = 返回全部，按 id 倒序'],
        ['page', 'int', '页码，默认 1'],
        ['pageSize', 'int', '每页大小，默认 20，上限 100'],
        ['source_id', 'int', '可选，限定某个蓝奏账号来源（必须在 Key 授权的库范围内）']
      ],
      response: `{
  "code": 200,
  "total": 1287,                  // 实际命中数（受 cap_limit 截顶；超出时 capped=true）
  "capped": false,                // 命中数被截顶时为 true，前端可提示"结果过多请细化关键词"
  "cap_limit": 1000,              // 当前 Key 的搜索上限（在后台签发时配置，默认 1000）
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
      title: '查看单个资源详情（不消耗配额）',
      desc: '通过 id 取一条资源的所有元数据（包含 share_url，但不含直链）。如该资源所属库不在当前 Key 授权范围内，返回 403。',
      params: [['id', 'int', '资源 id（path 参数）']],
      response: `{
  "code": 200,
  "item": {
    "id": 17,
    "source_id": 1,
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
      title: '换取直链（消耗配额的唯一路径）',
      desc: '实时返回下载直链。直链有时效（约 30 分钟），过期请重新调用本接口。同一资源 30 分钟内重复调用会命中服务端缓存（Redis），不会穿透到蓝奏，响应里 cached=true。⚠️ 这是唯一会扣 daily_limit / total_limit 的接口。',
      params: [['id', 'int', '资源 id（path 参数）']],
      response: `{
  "code": 200,
  "file_name": "Python入门到入土.zip",
  "file_size": "4260",
  "file_size_human": "4.16 MB",
  "url": "https://developer-cdn.lanrar.com/file/...",
  "expire_at": 1715600000000,      // 直链预计失效毫秒时间戳
  "cached": false,                 // true = 命中缓存，未穿透蓝奏
  "daily_limit": 5000,             // 仅此接口返回配额字段
  "used_today": 13,                // 含本次（最接近实时的估算）
  "remaining_today": 4987
}`
    },
    {
      key: 'me',
      method: 'GET',
      path: '/api/v1/me',
      title: '查看 Key 自身配额与授权范围',
      desc: '调试用，返回当前 Key 的名称、配额、累计用量、授权访问的库列表。',
      params: [],
      response: `{
  "code": 200,
  "name": "小说站-生产",
  "key_prefix": "lhk_AbC123",
  "daily_limit": 5000,
  "total_limit": 0,
  "rate_per_min": 60,
  "max_results": 1000,                // 搜索单次最多返回多少条
  "allowed_source_ids": [3, 6],       // null = 全部库；数组 = 只能访问这几个
  "quota_only_counts": "GET /resources/:id/link",  // 哪些路径才计配额
  "used_today": 13,                   // 今日 /link 调用次数
  "used_total": 8642,                 // /link 累计调用
  "expire_at": "2026-05-15T00:00:00"
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

# 3. 查询自己 Key 的配额、授权库范围
curl -H "X-Api-Key: YOUR_API_KEY" \\
  "https://YOUR_HOST/api/v1/me"`,

    js: `// fetch 示例（Node 18+ / 浏览器）
const HOST = 'https://YOUR_HOST';
const KEY  = 'YOUR_API_KEY';

async function search(q, page = 1) {
  const url = \`\${HOST}/api/v1/search?q=\${encodeURIComponent(q)}&page=\${page}\`;
  const r = await fetch(url, { headers: { 'X-Api-Key': KEY } });
  if (!r.ok) throw new Error('搜索失败 HTTP ' + r.status);
  const d = await r.json();
  if (d.capped) console.warn('命中过多已截顶到 ' + d.cap_limit + ' 条，请细化关键词');
  return d;
}

async function getDirectLink(id) {
  const r = await fetch(\`\${HOST}/api/v1/resources/\${id}/link\`, {
    headers: { 'X-Api-Key': KEY }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message);
  return d;
}

// 用户搜 -> 显示列表 -> 点击某条 -> 才换直链（搜索不计费）
const list = await search('python');
const picked = list.items[0];
const link = await getDirectLink(picked.id);
console.log('直链:', link.url, '过期时间:', new Date(link.expire_at).toLocaleString());
console.log('今日已用 ' + link.used_today + ' / ' + link.daily_limit);`,

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
    d = r.json()
    if d.get('capped'):
        print(f"结果过多已截顶到 {d['cap_limit']} 条，请细化关键词")
    return d

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
print('直链:', link['url'], '今日已用:', link.get('used_today'))`,

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
if (!empty($res['capped'])) {
    echo "结果过多已截顶到 " . $res['cap_limit'] . " 条\n";
}
foreach ($res['items'] as $r) {
    echo $r['id'] . ' ' . $r['file_name'] . ' ' . $r['file_size_human'] . PHP_EOL;
}

// 2) 取直链
$picked = $res['items'][0];
$link = lrh_get($HOST . '/api/v1/resources/' . $picked['id'] . '/link', $KEY);
echo '直链: ' . $link['url'] . PHP_EOL;`
  },
  errors: [
    ['401', '缺少或无效的 X-Api-Key 头；或 Key 已过期'],
    ['403', '该资源所属库不在当前 Key 的授权范围内'],
    ['404', '资源不存在或已被同步流程标记为删除'],
    ['429', '触发限流：日配额用尽 / 总配额用尽 / 每分钟过快'],
    ['502', '蓝奏侧解析失败：账号被风控、文件被删、或网络异常']
  ],
  notes: [
    '流式搜索接口 /search/stream 使用 SSE。下游网站想让用户“先看到前几条，再继续加载”，可以用 fetch + ReadableStream 读取 item 事件；普通分页接口 /search 仍然保留，适合兼容性优先的场景。',
    '推荐流程：先调 /search 拿元数据列表 → 用户在你的站点点击某条 → 再调 /resources/:id/link 换直链。这样既省配额（前两步免费），也降低被风控的概率。',
    '配额只在 /resources/:id/link 一处计算。/search / /resources/:id / /me 全部不消耗 daily_limit 和 total_limit，可放心高频调用。',
    '4xx / 5xx 响应不计配额。只有成功返回直链才扣 1。',
    '搜索结果会受 Key 的 max_results 截顶（默认 1000）；如果 capped=true，说明命中数超过该上限，建议下游加更精确的关键词。',
    '一个 Key 可以绑定指定的几个库（allowed_source_ids）。访问授权外的资源会得到 403——这是接入方按数据来源分隔账号的方式。',
    '文件大小优先展示 file_size_human（已带单位）；file_size 是蓝奏原始值，ilanzou 是纯 KB 数字（"4260" 表示 4260 KB），老版蓝奏可能带单位（如 "12.3 M"）。',
    '搜索优先使用 Meilisearch 轻量索引；外部搜索未启用或短暂不可用时可回落 MySQL FULLTEXT。默认禁止单字搜索，建议下游做 200-300ms 输入防抖。',
    '直链有时效（约 30 分钟），不要在数据库长期保存，每次用户点击下载时即时调用。',
    'Key 泄露请立即在后台「API Key」页停用并重新签发，旧 Key 立即失效。',
    '建议下游在多用户并发场景下做 200~500ms 的随机延迟，防止本地 IP 触发蓝奏侧 IP 限流。'
  ]
};
