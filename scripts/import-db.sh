#!/usr/bin/env bash
# Import midnight-debug.sql.gz → midnight-debug.db (recreates from scratch)
set -euo pipefail

GZ="${1:-midnight-debug.sql.gz}"
DB="${2:-midnight-debug.db}"

if [ ! -f "$GZ" ]; then
  echo "Error: $GZ not found" >&2
  exit 1
fi

if [ -f "$DB" ]; then
  echo "Removing existing $DB..."
  rm -f "$DB" "${DB}-shm" "${DB}-wal"
fi

gunzip -c "$GZ" | sqlite3 "$DB"

echo "Imported $GZ → $DB ($(du -h "$DB" | cut -f1))"
