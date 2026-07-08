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

jest.setTimeout(30000);
