#!/usr/bin/env bash
# 备份 MySQL 数据 + 代码 tar 包
set -e
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"

# 读取 .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs -d '\n')
fi

DB_NAME=${DB_NAME:-lanzou_hub}
DB_USER=${DB_USER:-root}
DB_PASS=${DB_PASSWORD:-}
DB_HOST=${DB_HOST:-127.0.0.1}

echo "==> 导出数据库 $DB_NAME..."
mysqldump -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" --single-transaction --quick --routines "$DB_NAME" \
  | gzip > "$BACKUP_DIR/db_${TS}.sql.gz"

echo "==> 打包代码..."
tar --exclude='./node_modules' --exclude='./logs' --exclude='./backups' --exclude='./.git' \
    -czf "$BACKUP_DIR/code_${TS}.tar.gz" ./

echo "✓ 备份完成: $BACKUP_DIR/*_${TS}*"
ls -lh "$BACKUP_DIR" | tail -5
