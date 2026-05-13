#!/usr/bin/env bash
# 自检脚本：连通性 + 依赖 + 端口
set +e
PORT=${PORT:-3000}
echo "==> Node: $(node -v 2>/dev/null || echo MISSING)"
echo "==> NPM:  $(npm -v 2>/dev/null || echo MISSING)"
echo "==> PM2:  $(pm2 -v 2>/dev/null || echo MISSING)"

if command -v ss >/dev/null 2>&1; then
  ss -lnt | grep ":$PORT " && echo "==> 端口 $PORT 已监听" || echo "==> 端口 $PORT 未监听"
fi

if command -v curl >/dev/null 2>&1; then
  echo "==> /healthz:"
  curl -s -m 3 "http://127.0.0.1:$PORT/healthz" || echo "(无响应)"
  echo ""
fi
