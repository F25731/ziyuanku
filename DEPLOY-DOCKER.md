# Docker Compose 部署

## 服务器一键部署

### 前置要求
- Linux 服务器（Ubuntu 20+ / Debian 11+ / CentOS 8+）
- Docker 20.10+ 和 Docker Compose v2
- 开放对外端口（默认 3000；建议用 Nginx 反代到 443）

没装 Docker 的话：
```bash
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker $USER   # 加当前用户到 docker 组，重新登录生效
```

### 一、克隆仓库
```bash
cd /opt
git clone https://github.com/F25731/ziyuanku.git lanzou-hub
cd lanzou-hub
```

### 二、准备 .env
```bash
cp .env.docker.example .env
# 生成随机 JWT_SECRET（Linux 上直接替换）
sed -i "s/please_change_me_to_a_long_random_string/$(openssl rand -hex 32)/" .env
# 编辑数据库密码、管理员初始密码
vi .env
```

**`.env` 里必改的三项：**
- `DB_PASSWORD` — 应用连数据库的密码
- `MYSQL_ROOT_PASSWORD` — MySQL root 密码
- `ADMIN_INIT_PASSWORD` — 后台首次登录密码

### 三、启动
```bash
docker compose up -d --build
```

### 四、查看日志 & 验证
```bash
docker compose ps
docker compose logs -f app           # 应用日志
docker compose logs --tail=50 mysql  # mysql 初始化
```

看到 `[OK] lanzou-resource-hub listening on :3000` 就成了。

浏览器打开：`http://你的服务器IP:3000/admin/login.html`
账号：`admin` / 你在 `.env` 里设的 `ADMIN_INIT_PASSWORD`

### 五、Nginx 反代（推荐）
```bash
# 把 .env 里 APP_PORT 改成只绑 127.0.0.1（避免 3000 暴露在公网）
# APP_PORT=127.0.0.1:3000   <- 不是这样
# 正确做法：修改 docker-compose.yml 的 ports 段：
#   ports:
#     - "127.0.0.1:3000:3000"
docker compose up -d
```

Nginx 配置：
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
```bash
sudo certbot --nginx -d hub.yourdomain.com
```

## 日常运维

```bash
# 查看状态
docker compose ps

# 停止 / 启动
docker compose stop
docker compose start

# 重启 app（改了 .env 后）
docker compose up -d app

# 完全重建 app（改了代码 / 拉了新版）
git pull
docker compose up -d --build app

# 看实时日志
docker compose logs -f app

# 进入 app 容器 shell
docker compose exec app sh

# 进入 mysql
docker compose exec mysql mysql -uroot -p lanzou_hub

# 备份 MySQL
docker compose exec -T mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" lanzou_hub \
  | gzip > backup_$(date +%Y%m%d).sql.gz

# 恢复
gunzip < backup_20260513.sql.gz \
  | docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" lanzou_hub
```

## 升级

```bash
git pull
docker compose up -d --build app
docker compose logs -f app    # 看一下启动有没有问题
```
启动时会自动跑数据库迁移，新的 SQL 文件会自动执行。

## 卸载（连数据一起清）

```bash
docker compose down -v   # -v 同时删掉 mysql_data / redis_data volume，慎用
```

## 故障排查

**app 启动失败 / 一直 restarting：**
```bash
docker compose logs --tail=100 app
```
常见原因：
- `.env` 少了 `DB_PASSWORD` / `JWT_SECRET`
- MySQL 还没就绪（compose 有 healthcheck 应该不会，但如果首次磁盘慢，等 30s）

**连不上 MySQL：**
容器内用 `mysql` 作主机名，不是 `127.0.0.1`，这个已经在 compose 里设好。

**Redis 连不上 / 直链不缓存：**
```bash
docker compose exec redis redis-cli ping   # 应返回 PONG
```

**端口被占：**
改 `.env` 里的 `APP_PORT=3001` 再 `docker compose up -d`。
