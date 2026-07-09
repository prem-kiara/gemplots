import { test, expect, Page } from '@playwright/test';

/**
 * Playwright smoke (docs/10 §14) — the golden path end to end against the ephemeral e2e stack
 * (API :3010 + web :3011 + gemplots_e2e), booted/torn down by e2e/run-e2e.sh.
 *
 *  Part 1 (customer): email-OTP login → open Gem Meadows → map renders ≥3 plot polygons →
 *    reserve an available plot → confirm the reserve OTP → status shows "Awaiting approval".
 *  Part 2 (admin): admin login → bell/inbox shows the pending request → open review detail
 *    (guardrails visible) → Approve → the customer booking shows RESERVED.
 *
 * The two parts share state via module-scoped vars; the file runs serially (workers:1).
 */

const ADMIN_EMAIL = 'ops@gemhousing.in';
const ADMIN_PASSWORD = 'GemHousing@Dev1';

// Shared across the serial parts.
let customerEmail = '';
let reserveUrl = ''; // /reserve/{bookingId}
let reservedPlotNumber = '';

test.describe.configure({ mode: 'serial' });

/** Read the OTP shown in the amber DEV MODE banner (Invariant 12 exposes it in demo mode). */
async function readDevOtp(page: Page): Promise<string> {
  const banner = page.locator('button', { hasText: 'DEV MODE — OTP' }).first();
  await expect(banner).toBeVisible({ timeout: 15_000 });
  const text = (await banner.innerText()).trim();
  const m = text.match(/(\d{6})/);
  expect(m, `dev OTP not found in banner: "${text}"`).toBeTruthy();
  return m![1];
}

test.describe('Smoke part 1 — customer reserve journey', () => {
  test('login → open project → map ≥3 polygons → reserve → confirm OTP → Awaiting approval', async ({
    page,
  }) => {
    customerEmail = `e2e-${Date.now()}@test.gemhousing.in`;

    // --- email-OTP login ---
    await page.goto('/login');
    await page.getByLabel('Email address').fill(customerEmail);
    await page.getByRole('button', { name: 'Send code' }).click();

    const otp = await readDevOtp(page);
    // Tap-to-fill fills the OTP boxes; OtpInput auto-submits on the 6th digit.
    await page.locator('button', { hasText: 'DEV MODE — OTP' }).first().click();
    // After verify the app redirects to `next` (/me by default). Wait for the session to settle.
    await expect(page).toHaveURL(/\/me$/, { timeout: 20_000 });

    // --- open Gem Meadows from home ---
    await page.goto('/');
    await page.getByRole('heading', { name: 'Gem Meadows' }).click();
    await expect(page).toHaveURL(/\/p\/gem-meadows$/);

    // --- map renders ≥3 plot polygons ---
    const polygons = page.locator('svg polygon[role="button"]');
    await expect(polygons.first()).toBeVisible({ timeout: 20_000 });
    expect(await polygons.count()).toBeGreaterThanOrEqual(3);

    // --- pick an AVAILABLE plot (green fill #16a34a) and open its sheet ---
    const available = page.locator('svg polygon[role="button"][fill="#16a34a"]').first();
    await expect(available).toBeVisible();
    const label = await available.getAttribute('aria-label'); // "Plot P-0X, Available, ₹..."
    reservedPlotNumber = (label?.match(/Plot (\S+),/) || [])[1] || '';
    expect(reservedPlotNumber).toBeTruthy();
    await available.click();

    // --- reserve ---
    await page.getByRole('button', { name: 'Reserve this plot' }).click();
    await expect(page).toHaveURL(/\/reserve\/[0-9a-f-]+$/, { timeout: 20_000 });
    reserveUrl = new URL(page.url()).pathname;

    // --- confirm the reserve OTP (second banner on the reserve journey) ---
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await page.locator('button', { hasText: 'DEV MODE — OTP' }).first().click(); // tap-to-fill → auto-submit

    // --- status shows "Awaiting approval" ---
    await expect(page.getByRole('heading', { name: 'Awaiting approval' })).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe('Smoke part 2 — admin approve → customer RESERVED', () => {
  test('admin login → inbox pending → review (guardrails) → Approve → customer sees Reserved', async ({
    page,
  }) => {
    expect(reserveUrl, 'part 1 must have produced a reservation').toBeTruthy();

    // --- admin login ---
    await page.goto('/admin');
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin\/home$/, { timeout: 20_000 });

    // --- inbox shows the pending request ---
    await page.goto('/admin/inbox');
    await expect(page.getByRole('heading', { name: 'Approvals inbox' })).toBeVisible();
    const reserveRow = page.getByRole('row', { name: /Plot reservation/ }).first();
    await expect(reserveRow).toBeVisible({ timeout: 20_000 });
    await reserveRow.click();

    // --- review detail: guardrails visible ---
    await expect(page).toHaveURL(/\/admin\/inbox\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: 'Guardrails' })).toBeVisible();

    // --- approve (button → confirm dialog → confirm) ---
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve this reservation?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();

    // Back to inbox after the decision.
    await expect(page).toHaveURL(/\/admin\/inbox$/, { timeout: 20_000 });

    // --- customer booking now RESERVED (re-open the reserve journey and poll) ---
    await page.goto(reserveUrl);
    await expect(page.getByRole('heading', { name: 'Reserved in your name' })).toBeVisible({
      timeout: 20_000,
    });
  });
});
