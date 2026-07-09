#!/usr/bin/env bash
# run-e2e.sh (P8, docs/10 §14) — provision an ISOLATED e2e stack, run the Playwright smoke, tear
# everything down. Deliberately isolated from any running dev stack:
#   * DB:   gemplots_e2e  (created + dropped here; never touches gemplots / gemplots_test)
#   * API:  port 3010     (compiled to api/dist.e2e — never touches api/dist)
#   * Web:  port 3011     (NEXT_DIST_DIR=.next-e2e — never touches web/.next)
#   * Email console mode, NODE_ENV != production → dev_otp is exposed (Invariant 12).
# Never binds 3000/3001.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# --- config -----------------------------------------------------------------
DB_NAME="gemplots_e2e"
DB_URL_ADMIN="${E2E_DATABASE_URL_ADMIN:-postgres://localhost:5432/${DB_NAME}}"
DB_URL_APP="${E2E_DATABASE_URL:-postgres://gemplots_app:gemplots_app_dev@localhost:5432/${DB_NAME}}"
API_PORT=3010
WEB_PORT=3011
API_DIST="dist.e2e"
WEB_DISTDIR=".next-e2e"
E2E_UPLOADS="$REPO_ROOT/api/uploads-e2e"

API_PID=""
WEB_PID=""
EXIT_CODE=1

log() { echo "[e2e] $*"; }

cleanup() {
  log "tearing down…"
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null && wait "$WEB_PID" 2>/dev/null
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null && wait "$API_PID" 2>/dev/null
  # Drop the ephemeral DB (best effort).
  dropdb --if-exists "$DB_NAME" 2>/dev/null || true
  # Remove ephemeral build/upload artifacts.
  rm -rf "$REPO_ROOT/api/$API_DIST" "$E2E_UPLOADS" "$REPO_ROOT/web/$WEB_DISTDIR" 2>/dev/null || true
  log "done (exit $EXIT_CODE)"
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1" name="$2" tries=120
  for _ in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then log "$name is up"; return 0; fi
    sleep 1
  done
  log "ERROR: $name did not become ready at $url"
  return 1
}

# --- 1. provision gemplots_e2e ----------------------------------------------
log "provisioning $DB_NAME"
dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"
DATABASE_URL_ADMIN="$DB_URL_ADMIN" bash db/migrate.sh
psql "$DB_URL_ADMIN" -v ON_ERROR_STOP=1 -q -f db/seed.sql

# --- 2. copy the seed site-plan asset into the e2e uploads dir ---------------
mkdir -p "$E2E_UPLOADS/seed"
cp db/assets/gem-meadows-v1.svg "$E2E_UPLOADS/seed/gem-meadows-v1.svg"

# --- 3. build + boot the API on :3010 (isolated dist, gemplots_e2e) ----------
log "compiling API → api/$API_DIST"
( cd api && npx tsc -p tsconfig.build.json --outDir "$API_DIST" >/dev/null )

log "starting API on :$API_PORT"
(
  cd api
  DATABASE_URL="$DB_URL_APP" \
  REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
  PORT="$API_PORT" \
  WORKER_MODE=all \
  NODE_ENV=development \
  EMAIL_MODE=console \
  STORAGE_MODE=local \
  UPLOADS_DIR="$E2E_UPLOADS" \
  PAYMENTS_ENABLED=false \
  JWT_SECRET=e2e-access-secret JWT_REFRESH_SECRET=e2e-refresh-secret OTP_PEPPER=e2e-pepper \
  ADMIN_ALERT_EMAIL=admin@gemhousing.in \
  SWEEP_INTERVAL_MS=5000 \
  node "$API_DIST/main.js"
) &
API_PID=$!
wait_for_http "http://localhost:$API_PORT/health" "API" || exit 1

# --- 4. boot Next on :3011 (dev server, isolated dist, proxy → :3010) --------
log "starting web on :$WEB_PORT"
(
  cd web
  API_ORIGIN="http://localhost:$API_PORT" \
  NEXT_DIST_DIR="$WEB_DISTDIR" \
  npx next dev -p "$WEB_PORT"
) &
WEB_PID=$!
wait_for_http "http://localhost:$WEB_PORT" "web" || exit 1

# --- 5. run the Playwright smoke --------------------------------------------
log "running Playwright smoke"
(
  cd web
  E2E_BASE_URL="http://localhost:$WEB_PORT" npx playwright test "$@"
)
EXIT_CODE=$?

exit $EXIT_CODE
