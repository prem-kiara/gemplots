# Deploy Runbook — Gem Plots (plots.gemhousing.in)

Single-host deployment: one machine runs Postgres, Redis, the NestJS API, the Next.js web app,
and Caddy as the TLS reverse proxy. Scales to a small VPS (2 vCPU / 4 GB). For larger scale,
split the API worker (`WORKER_MODE=worker`) and use managed Postgres/Redis — the app is
already structured for it.

## 1. Topology

```
                 ┌─────────── Caddy (:443, TLS) ───────────┐
 plots.gemhousing.in ─▶  /api/*  → :3000 (Nest API)         │
                        /files/* → :3000 (uploaded images)  │
                        /health  → :3000                    │
                        everything else → :3001 (Next.js)   │
                 └─────────────────────────────────────────┘
   Nest API :3000 ──▶ PostgreSQL (gemplots)  +  Redis
   Next.js  :3001 (static SPA + client rendering; calls /api same-origin)
```

Config: [infra/Caddyfile](../infra/Caddyfile) (drop in `/etc/caddy/Caddyfile`).

## 2. Provision

```bash
# System deps
apt install -y postgresql-15 redis caddy nodejs npm   # Node 22 via nodesource
# App user + checkout
useradd -m gemplots && su - gemplots
git clone https://github.com/prem-kiara/gemplots.git && cd gemplots
npm ci                              # installs api + web workspaces
```

## 3. Environment (prod)

Create `/srv/gemplots/api/.env` (see [.env.example](../.env.example)). **Production-critical:**

- `NODE_ENV=production` — the app **refuses to boot** with unset or dev-default
  `JWT_SECRET` / `JWT_REFRESH_SECRET` / `OTP_PEPPER` (P0 fix F5). Generate strong secrets:
  `openssl rand -hex 32` for each.
- `DATABASE_URL=postgres://gemplots_app:<strong-pw>@localhost:5432/gemplots` — the app connects
  as the **non-owner** `gemplots_app` role (so the `audit_logs` REVOKE has teeth — Invariant 10).
  `DATABASE_URL_ADMIN` (owner) is used only by migrate/seed/backup.
- `REDIS_URL=redis://localhost:6379`
- **Email go-live:** `EMAIL_MODE=smtp` + `SMTP_HOST/PORT/USER/PASS/FROM` (a real
  `noreply@gemhousing.in` mailbox). Until then, `EMAIL_MODE=console` runs demo mode
  (codes on-screen, outbox viewer) — **do NOT run console mode in production** (it exposes OTPs).
- `ADMIN_ALERT_EMAIL=admin@gemhousing.in` — where reservation-approval requests are emailed.
- `STORAGE_MODE=local` + `UPLOADS_DIR=/srv/gemplots/uploads` (persisted, backed up). Move to
  `STORAGE_MODE=s3` when you outgrow one host.
- `PAYMENTS_ENABLED=false` — payments stay dormant until a gateway is wired; flipping to `true`
  re-arms the fully-built, tested Razorpay path.
- `PUBLIC_BASE_URL=https://plots.gemhousing.in`, `WORKER_MODE=all` (single host runs API + sweeper).

## 4. Database

```bash
# As the DB owner (superuser/postgres):
createdb gemplots
DATABASE_URL_ADMIN=postgres://localhost:5432/gemplots bash db/migrate.sh   # applies V1..V6

# Production seed = ADMIN USERS ONLY (no demo project/plots).
# db/seed.sql seeds the demo Gem Meadows project — do NOT run it in prod as-is. Instead insert
# your real admins (argon2id password hashes) and create real projects through the admin portal
# (Projects → New project → CSV plots → site-map editor → Publish). To generate an admin hash:
#   node -e "require('argon2').hash(process.argv[1],{type:require('argon2').argon2id}).then(console.log)" 'YourStrongPw'
```

The `gemplots_app` role and its grants (incl. the audit-immutability REVOKE) are created by
migration `V4`. Change its password from the dev default and match `DATABASE_URL`.

## 5. Build & run

```bash
# API
npm --workspace api run build           # → api/dist
# Web
npm --workspace web run build           # → web/.next  (Next production build)

# Run as services (systemd units recommended). Manually:
NODE_ENV=production node api/dist/main.js            # API + worker on :3000
npm --workspace web run start -- -p 3001             # next start on :3001
caddy run --config /etc/caddy/Caddyfile              # TLS edge on :443
```

Systemd sketch (one unit each): `gemplots-api.service` (`ExecStart=/usr/bin/node
/srv/gemplots/api/dist/main.js`, `EnvironmentFile=/srv/gemplots/api/.env`),
`gemplots-web.service` (`ExecStart=npm --workspace web run start -- -p 3001`), and Caddy's
packaged unit. `Restart=always` on both app units.

## 6. Backup & restore

- **Backup:** [scripts/backup.sh](../scripts/backup.sh) — nightly `pg_dump` (gzip) + optional
  uploads tarball into `BACKUP_DIR`, prunes past `RETENTION_DAYS`. Cron example is in the script
  header (`30 2 * * *`). Ship dumps off-host (S3/rsync) for real durability.
- **RPO/RTO targets:** RPO 24h with nightly dumps (tighten with WAL archiving / PITR if needed);
  RTO ~30 min on a fresh host.
- **Restore drill** (run quarterly):
  ```bash
  createdb gemplots_restore
  gunzip -c /var/backups/gemplots/gemplots-db-<stamp>.sql.gz | psql gemplots_restore
  # verify row counts + latest audit id match production within RPO
  psql gemplots_restore -c "SELECT count(*) FROM bookings; SELECT max(id) FROM audit_logs;"
  # restore uploads: tar -xzf gemplots-files-<stamp>.tar.gz -C /srv/gemplots/
  ```

## 7. Operate

- **Health:** `GET https://plots.gemhousing.in/health` → `{status:'ok',db,redis}`. Point uptime
  monitoring here.
- **Logs:** the API emits structured per-request lines (request_id, method, path, status, ms) —
  ship to your log aggregator; every error envelope carries the same `request_id`.
- **Rate limits:** tune `THROTTLE_GLOBAL_MAX` / `THROTTLE_AUTH_MAX` / `THROTTLE_LOGIN_MAX` /
  `THROTTLE_WINDOW_MS` per traffic.
- **Deadline reminders:** the worker sweeps hourly-ish and emails customers (verify) + admins
  (T-6h approval nudge) — verify SMTP is live so these actually send.
- **Migrations on deploy:** `bash db/migrate.sh` is idempotent (tracks applied versions); run it
  before starting the new API build. Never edit an applied migration — add `V7+`.

## 8. Go-live checklist

- [ ] Strong `JWT_SECRET` / `JWT_REFRESH_SECRET` / `OTP_PEPPER` (not dev defaults) — else boot fails.
- [ ] `gemplots_app` password changed; app connects as non-owner; `audit_logs` UPDATE/DELETE denied.
- [ ] `EMAIL_MODE=smtp` with a working `noreply@gemhousing.in` mailbox (send a test OTP).
- [ ] `NODE_ENV=production` everywhere; console/dev_otp exposure OFF.
- [ ] Real admins seeded; demo Gem Meadows NOT in prod (or removed).
- [ ] Caddy TLS issued for plots.gemhousing.in; `/health` green through the edge.
- [ ] `backup.sh` in cron + one restore drill completed; uploads dir on backed-up storage.
- [ ] Uptime monitor on `/health`; log shipping on.
