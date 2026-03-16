#!/usr/bin/env bash
# Export midnight-debug.db → midnight-debug.sql.gz (for git)
# Checkpoints WAL first so all data is in the main db file.
set -euo pipefail

DB="${1:-midnight-debug.db}"
OUT="${2:-midnight-debug.sql.gz}"

if [ ! -f "$DB" ]; then
  echo "Error: $DB not found" >&2
  exit 1
fi

sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" > /dev/null 2>&1 || true
sqlite3 "$DB" .dump | gzip > "$OUT"

echo "Exported $DB → $OUT ($(du -h "$OUT" | cut -f1))"
