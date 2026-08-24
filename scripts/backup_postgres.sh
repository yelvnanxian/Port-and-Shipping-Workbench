#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="$project_dir/data/db-backups"
db_url="${1:-${DATABASE_URL:-}}"

if [[ -z "$db_url" && -f "$project_dir/.env" ]]; then
  db_url="$(sed -n 's/^DATABASE_URL=//p' "$project_dir/.env" | head -n 1)"
  db_url="${db_url#\"}"
  db_url="${db_url%\"}"
fi

if [[ -z "$db_url" ]]; then
  echo "未找到 DATABASE_URL。请先设置环境变量，或在 .env 中配置 DATABASE_URL。" >&2
  exit 1
fi
command -v pg_dump >/dev/null 2>&1 || { echo "未找到 pg_dump，请先安装 PostgreSQL 客户端。" >&2; exit 1; }

mkdir -p "$backup_dir"
timestamp="$(date '+%Y%m%d-%H%M%S')"
target="$backup_dir/port_ops_${timestamp}.dump"
pg_dump --format=custom --no-owner --file="$target" "$db_url"
chmod 600 "$target"
echo "PostgreSQL 备份已创建：$target"
