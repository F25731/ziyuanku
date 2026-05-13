#!/usr/bin/env bash
# 一键安装：Ubuntu 20+ / Debian 11+ / CentOS 8+
set -e

echo "==> 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 18+: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 版本过低 ($(node -v))，需要 >= 18"
  exit 1
fi

echo "==> 安装依赖..."
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  echo "==> 生成 .env（请务必修改其中的密码和 JWT_SECRET）"
  cp .env.example .env
  RAND=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s/please_change_this_to_a_long_random_string/$RAND/" .env
  echo "==> JWT_SECRET 已随机生成"
fi

mkdir -p logs

echo "==> 执行数据库迁移..."
node scripts/run_migrations.js

echo ""
echo "✓ 安装完成"
echo ""
echo "下一步："
echo "  1) 编辑 .env 填写 MySQL / Redis / 管理员密码"
echo "  2) 启动: npm start  （或 pm2 start ecosystem.config.js）"
echo "  3) 访问: http://<你的IP>:3000/admin/login.html"
