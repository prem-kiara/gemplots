#!/usr/bin/env bash
# Minimal Flyway-style migration runner (HANDOVER §7). Applies V*__*.sql in order once each,
# tracked in schema_migrations. Runs as the DB owner/admin (DATABASE_URL_ADMIN).
set -euo pipefail

DB="${DATABASE_URL_ADMIN:-${DATABASE_URL:?set DATABASE_URL_ADMIN or DATABASE_URL}}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/migrations"

psql "$DB" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"

for f in $(ls "$DIR"/V*__*.sql | sort); do
  version="$(basename "$f" | sed -E 's/__.*//')"       # V1, V2, ...
  applied="$(psql "$DB" -tAc "SELECT 1 FROM schema_migrations WHERE version='$version'")"
  if [ "$applied" = "1" ]; then
    echo "skip   $version ($(basename "$f"))"
    continue
  fi
  echo "apply  $version ($(basename "$f"))"
  psql "$DB" -v ON_ERROR_STOP=1 -q -1 -f "$f"
  psql "$DB" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO schema_migrations(version) VALUES ('$version')"
done
echo "migrations up to date"
