#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="$project_dir/data/db-backups"
db_url="${DATABASE_URL:-}"
backup_name="${1:-}"

if [[ -z "$db_url" && -f "$project_dir/.env" ]]; then
  db_url="$(sed -n 's/^DATABASE_URL=//p' "$project_dir/.env" | head -n 1)"
  db_url="${db_url#\"}"
  db_url="${db_url%\"}"
fi
if [[ -z "$db_url" || -z "$backup_name" ]]; then
  echo "用法：DATABASE_URL=... $0 data/db-backups/port_ops_YYYYMMDD-HHMMSS.dump" >&2
  exit 1
fi
command -v pg_restore >/dev/null 2>&1 || { echo "未找到 pg_restore，请先安装 PostgreSQL 客户端。" >&2; exit 1; }

backup_path="$backup_name"
if [[ "$backup_path" != /* ]]; then backup_path="$project_dir/$backup_path"; fi
backup_path="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$backup_path")"
case "$backup_path" in
  "$backup_dir"/*) ;;
  *) echo "恢复文件必须位于 $backup_dir 目录内。" >&2; exit 1 ;;
esac
[[ -f "$backup_path" ]] || { echo "备份文件不存在：$backup_path" >&2; exit 1; }

if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  echo "警告：恢复会覆盖目标数据库中的同名表。"
  read -r -p "输入 RESTORE 继续：" confirmation
  [[ "$confirmation" == "RESTORE" ]] || { echo "已取消恢复。"; exit 1; }
fi

pg_restore --clean --if-exists --no-owner --dbname="$db_url" "$backup_path"
echo "PostgreSQL 已恢复：$backup_path"
