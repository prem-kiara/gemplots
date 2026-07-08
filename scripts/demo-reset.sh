#!/usr/bin/env bash
# demo-reset.sh (D3) — one command to a pristine demo: drop → create → migrate → seed → assets.
# Rebuilds the `gemplots` dev database from scratch and copies the checked-in site-plan asset into
# the local-disk uploads dir so GET /files/seed/gem-meadows-v1.svg resolves (08 §8, Invariant 11).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_NAME="${DB_NAME:-gemplots}"
DB_URL_ADMIN="${DATABASE_URL_ADMIN:-postgres://localhost:5432/${DB_NAME}}"
# UPLOADS_DIR default matches api/.env (UPLOADS_DIR=./uploads relative to the api/ cwd → api/uploads).
UPLOADS_DIR="${UPLOADS_DIR:-api/uploads}"

echo "==> dropping + recreating ${DB_NAME}"
dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"

echo "==> migrating"
DATABASE_URL_ADMIN="$DB_URL_ADMIN" bash db/migrate.sh

echo "==> seeding"
psql "$DB_URL_ADMIN" -v ON_ERROR_STOP=1 -q -f db/seed.sql

echo "==> copying site-plan asset into ${UPLOADS_DIR}/seed"
mkdir -p "${UPLOADS_DIR}/seed"
cp db/assets/gem-meadows-v1.svg "${UPLOADS_DIR}/seed/gem-meadows-v1.svg"

echo ""
echo "==> DONE. Demo data is ready."
echo "    Admin portal login (any role, password: GemHousing@Dev1):"
echo "      super@gemhousing.in    (SUPER_ADMIN)"
echo "      ops@gemhousing.in      (OPERATIONS)"
echo "      sales@gemhousing.in    (SALES)"
echo "      finance@gemhousing.in  (FINANCE)"
echo "      auditor@gemhousing.in  (AUDITOR)"
echo "    Demo customer (email OTP login; code shown on screen in demo mode):"
echo "      customer@demo.gemhousing.in"
echo "    Project: Gem Meadows (slug: gem-meadows) — 12 plots."
