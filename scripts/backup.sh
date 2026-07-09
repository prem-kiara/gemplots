#!/usr/bin/env bash
# backup.sh — nightly logical backup of the Gem Plots database (docs/DEPLOY.md §Backup).
#
# Takes a compressed pg_dump of the app DB into BACKUP_DIR and prunes anything older than
# RETENTION_DAYS. Designed to run from cron; exit non-zero on any failure so cron mails you.
#
#   Env:
#     DATABASE_URL_ADMIN   owner/superuser connection to dump (required)
#     BACKUP_DIR           where dumps land           (default: /var/backups/gemplots)
#     RETENTION_DAYS       prune older than N days     (default: 14)
#     UPLOADS_DIR          local-disk uploads to back up too (optional; e.g. /srv/gemplots/uploads)
#
#   Example crontab (02:30 daily):
#     30 2 * * *  DATABASE_URL_ADMIN=postgres://localhost:5432/gemplots \
#                 BACKUP_DIR=/var/backups/gemplots /srv/gemplots/scripts/backup.sh >> /var/log/gemplots-backup.log 2>&1
set -euo pipefail

DB="${DATABASE_URL_ADMIN:?set DATABASE_URL_ADMIN}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gemplots}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

DB_OUT="$BACKUP_DIR/gemplots-db-$STAMP.sql.gz"
echo "==> pg_dump → $DB_OUT"
# --no-owner keeps the restore portable across roles; gzip for size.
pg_dump --no-owner --format=plain "$DB" | gzip -9 > "$DB_OUT"

# Optionally snapshot the local-disk uploads (site-plan images live outside the DB).
if [ -n "${UPLOADS_DIR:-}" ] && [ -d "$UPLOADS_DIR" ]; then
  FILES_OUT="$BACKUP_DIR/gemplots-files-$STAMP.tar.gz"
  echo "==> tar uploads → $FILES_OUT"
  tar -czf "$FILES_OUT" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
fi

echo "==> pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" -name 'gemplots-*.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete || true

echo "==> backup OK ($STAMP)"
