# 云逸蓝奏 · Lanzou Resource Hub

Headless 蓝奏云资源库。只做资源聚合、搜索、直链生成三件事，对外暴露 REST API，供下游软件站 / 小说站 / 工具站调用。

## 核心功能

- 后台账号密码登录（JWT），无注册/无会员/无卡密
- 蓝奏账号（ilanzou 新版）一键同步 → 入库
- `api.v1` 对外接口：搜索、取资源详情、换直链
- 每个下游站点一枚 API Key，可配 日/总配额 + 每分钟限流
- 直链 Redis 缓存，降低被风控概率
- 精美 Tailwind 后台（仪表盘 / 资源 / 来源 / API Key / 同步日志 / 调用日志）

## API 速查

```
# 对外 v1（需 X-Api-Key）
GET  /api/v1/search?q=xxx&page=1&pageSize=20
GET  /api/v1/search/stream?q=xxx&pageSize=20&limit=100   # SSE stream, emits meta/item/done/error
GET  /api/v1/resources/:id
GET  /api/v1/resources/:id/link   → { url, expire_at, cached, remaining_today }
GET  /api/v1/me

# 管理端（需 Authorization: Bearer <jwt>）
POST /api/admin/login             { username, password } → { token, user }
GET  /api/admin/stats
...（详见 routes/admin.js）
```

## 部署步骤（生产环境）

### 0. 前置要求
Ubuntu 20+ / Debian 11+ / CentOS 8+，已安装 MySQL 5.7+ 和 Redis 6+。

### 1. 安装 Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 要 >= 18
```

### 2. 克隆仓库
```bash
cd /opt
sudo git clone <你的仓库URL> lanzou-hub
sudo chown -R $USER:$USER lanzou-hub
cd lanzou-hub
```

### 3. 创建数据库
```bash
sudo mysql -uroot -p <<'SQL'
CREATE DATABASE lanzou_hub DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'lanzou_hub'@'127.0.0.1' IDENTIFIED BY '改成强密码';
GRANT ALL ON lanzou_hub.* TO 'lanzou_hub'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

### 4. 一键安装
```bash
chmod +x install.sh backup.sh healthcheck.sh
./install.sh
```

`install.sh` 会：
- `npm install`
- 拷贝 `.env.example` → `.env` 并随机生成 `JWT_SECRET`
- 执行数据库迁移
- 自动创建默认管理员 `admin / Admin@123456`

### 5. 修改 .env
```bash
vi .env
# 必改：
#   DB_PASSWORD=你刚才设置的
#   ADMIN_INIT_PASSWORD=改掉默认密码
#   REDIS_PASSWORD=（若有）
```

### 6. 启动（PM2）
```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd   # 按提示执行 sudo 命令
```

### 7. Nginx 反向代理（可选）
```nginx
server {
    listen 80;
    server_name hub.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
之后用 `certbot` 上 HTTPS。

### 8. 验证
```bash
./healthcheck.sh
curl http://127.0.0.1:3000/healthz
```
浏览器打开 `http://<IP>:3000/admin/login.html`，用 admin 账号登入。

## 首次使用流程

1. **登录后台** → 修改密码
2. **数据来源** → 新增你的蓝奏账号（ilanzou + account/password）→ 点"同步"
3. **API Key** → 签发一枚 key，复制下来（只显示一次）
4. **下游站**用这个 key 调 `/api/v1/search` 和 `/api/v1/resources/:id/link`

## 调用示例（下游软件站 / PHP）

```php
$ch = curl_init('https://hub.yourdomain.com/api/v1/search?q=' . urlencode($kw));
curl_setopt($ch, CURLOPT_HTTPHEADER, ['X-Api-Key: lhk_xxxxxxxx']);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
$data = json_decode(curl_exec($ch), true);
foreach ($data['items'] as $r) {
    echo $r['file_name'] . "\n";
}
```

流式搜索（SSE）：适合下游网站做“结果逐条出现”的体验。普通接口 `/api/v1/search` 仍然保留。

```bash
curl -N -H "X-Api-Key: lhk_xxxx" \
  "https://hub.yourdomain.com/api/v1/search/stream?q=python&pageSize=20&limit=100"
```

事件格式：

```text
event: meta
data: {"code":200,"message":"stream started","page_size":20,"limit":100}

event: item
data: {"index":1,"item":{"id":17,"file_name":"Python入门.zip"}}

event: done
data: {"code":200,"message":"ok","count":20,"next_cursor":"...","has_more":true}
```

取直链：
```bash
curl -H "X-Api-Key: lhk_xxxx" https://hub.yourdomain.com/api/v1/resources/1/link
# → {"code":200,"url":"https://...","expire_at":...,"remaining_today":99}
```

## 备份 / 升级

```bash
./backup.sh                       # MySQL + 代码打包到 backups/
git pull && ./install.sh          # 升级后再跑一次脚本
pm2 restart lanzou-resource-hub
```

## 架构

```
┌──────────────┐      ┌───────────────────────┐
│ 下游软件站   │─────▶│ /api/v1/*  (API Key)  │
└──────────────┘      │  + 限流 + 记录        │
                      └──────────┬────────────┘
                                 │
┌──────────────┐      ┌──────────▼────────────┐    ┌──────────┐
│ 管理员浏览器 │─────▶│ /admin + /api/admin   │───▶│  MySQL   │
└──────────────┘      │  (JWT)                │    └──────────┘
                      └──────────┬────────────┘    ┌──────────┐
                                 │ 解析+缓存        │  Redis   │
                                 └─────────────────▶│  (链接)  │
                                                   └──────────┘
```

## 目录

```
app.js                 入口
config/                MySQL / Redis 连接
database/migrations/   SQL 迁移文件
middleware/            JWT / API Key / 错误处理
routes/                admin.js + v1.js
services/              核心业务（解析器、同步、资源、来源、用户、key）
scripts/               同步脚本 + 迁移 runner
public/admin/          后台 UI（Tailwind + Alpine）
ecosystem.config.js    PM2 配置
install.sh / backup.sh / healthcheck.sh
```

## License

MIT
