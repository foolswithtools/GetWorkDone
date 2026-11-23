import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// Sign-in end to end (GWP#3): the built API runs the real OIDC provider against a local mock issuer, in
// production mode, against the run's scratch Postgres (support/api-server.ts). The browser signs in,
// sees its team list, and signs out.

let server: ApiServer;
let baseURL: string;
const run = randomUUID().slice(0, 8);

test.beforeAll(async () => {
  server = await startApiServer({ sub: `e2e-${run}`, email: `e2e-${run}@example.test`, name: `E2E User ${run}` });
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server.stop();
});

test('sign in, see the team list, sign out', async ({ page }) => {
  // GWP#48: the redirect round trip and sign-out break no CSP directive (support/csp.ts).
  watchCsp(page);
  await page.goto(`${baseURL}/`);
  await page.getByTestId('sign-in').click();

  // /auth/login → the issuer's /authorize → /auth/callback → /, signed in.
  await expect(page.getByTestId('signed-in-as')).toHaveText(`E2E User ${run}`);
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByTestId('no-teams')).toBeVisible();
  const session = (await page.context().cookies()).find((c) => c.name === '__Host-gwd_session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

  // A write needs the CSRF token from /api/v1/me; without it the session cookie alone is refused.
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json() as { csrfToken: string; subject: string };
  expect(me.subject).toBe(`e2e-${run}`);
  expect((await page.request.post(`${baseURL}/api/v1/teams`, { data: { name: `Refused ${run}` } })).status()).toBe(403);
  expect((await page.request.post(`${baseURL}/api/v1/teams`, { data: { name: `Team ${run}` }, headers: { 'X-GWD-CSRF': me.csrfToken } })).status()).toBe(201);

  await page.reload();
  await expect(page.getByTestId('team-list')).toContainText(`Team ${run} (admin)`);

  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('sign-in')).toBeVisible();
  expect((await page.request.get(`${baseURL}/api/v1/me`)).status()).toBe(401);
  expectNoCspViolations();

  // A real sign-in's token under the unprefixed name, as a sibling host could set it on a parent domain,
  // is no sign-in: 400 (GWP#17, D-087). Read as gwd_login, the token would pass and the bad code be 401.
  const login = await page.request.get(`${baseURL}/auth/login`, { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  const state = new URL(login.headers().location!).searchParams.get('state')!;
  const token = (await page.context().cookies()).find((c) => c.name === '__Host-gwd_login')!.value;
  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'gwd_login', value: token, url: baseURL }]);
  expect((await page.request.get(`${baseURL}/auth/callback?code=not-issued&state=${state}`, { maxRedirects: 0 })).status()).toBe(400);

  // The API's captured log output holds no token: `grep -c eyJ` would count zero.
  expect(server.output()).toContain('signed in');
  expect(server.output().match(/eyJ/g) ?? []).toHaveLength(0);
});
