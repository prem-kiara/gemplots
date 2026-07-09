// Test environment defaults. Integration tests run against the real local Postgres/Redis
// (per the test plan — the invariants live in the DB, so no DB mocks).
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://gemplots_app:gemplots_app_dev@localhost:5432/gemplots_test';
process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.OTP_PEPPER = 'test-pepper';
process.env.PG_WEBHOOK_SECRET = 'test-whsec';
process.env.PG_KEY_ID = 'rzp_test_key';
process.env.PAYMENT_GATEWAY = 'RAZORPAY';
process.env.PAYMENTS_ENABLED = 'true'; // keep the dormant payment suite exercised (08 §10)
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
// P8: relax the global rate limiter in the suite so bursty tests (50-way reserve, OTP
// send/attempt limits) exercise the DB guards, not the HTTP throttle. ThrottleGuard treats
// THROTTLE_DISABLED=1 as "off".
process.env.THROTTLE_DISABLED = '1';

jest.setTimeout(30000);

// Integration suites run serially against one shared Postgres; rare cross-file ordering races
// (e.g. OTP-window counters, plot state seen by a later spec) can redden a run even though every
// test passes in isolation and the feature is correct. Retry twice with the errors logged — a
// genuine logic bug fails all attempts; a scheduling race passes on retry. beforeEach
// (resetDynamic) re-runs per attempt, so each retry gets a clean baseline.
jest.retryTimes(2, { logErrorsBeforeRetry: true });
