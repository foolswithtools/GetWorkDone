import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// Sign out everywhere (GWP#56, docs/auth.md): one person signs in in two browsers (two contexts, so two
// cookie jars and two sessions) through the real OIDC flow against the mock issuer; "Sign out everywhere"
// in the first, once confirmed, ends the second's session too.

let server: ApiServer;
const run = randomUUID().slice(0, 8);
const person = { sub: `e2e-everywhere-${run}`, email: `everywhere-${run}@example.test`, name: `Everywhere ${run}` };

test.beforeAll(async () => {
  server = await startApiServer(person);
});

test.afterAll(async () => {
  await server.stop();
});

// GWP#48: no watched page broke a CSP directive or threw (support/csp.ts).
test.afterEach(() => expectNoCspViolations());

async function signIn(browser: Browser): Promise<Page> {
  const page = watchCsp(await (await browser.newContext()).newPage());
  await page.goto(`${server.baseURL}/`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(person.name);
  return page;
}

test('"Sign out everywhere" in one browser signs the same person out of another', async ({ browser }) => {
  const laptop = await signIn(browser);
  const phone = await signIn(browser);
  const sessionOf = async (page: Page) => (await page.context().cookies()).find((c) => c.name === '__Host-gwd_session')!.value;
  expect(await sessionOf(laptop)).not.toBe(await sessionOf(phone));

  // The first press only asks; keeping the sessions changes nothing.
  await laptop.getByTestId('sign-out-everywhere').click();
  await expect(laptop.getByTestId('sign-out-everywhere-confirm')).toBeVisible();
  await laptop.getByTestId('sign-out-everywhere-cancel').click();
  await expect(laptop.getByTestId('sign-out-everywhere-confirm')).toBeHidden();
  expect((await phone.request.get(`${server.baseURL}/api/v1/me`)).status()).toBe(200);

  await laptop.getByTestId('sign-out-everywhere').click();
  await laptop.getByTestId('sign-out-everywhere-confirm').click();
  await expect(laptop.getByTestId('sign-in')).toBeVisible();

  // The other browser's next request finds no session: the signed-out view.
  await phone.reload();
  await expect(phone.getByTestId('sign-in')).toBeVisible();
  expect((await phone.request.get(`${server.baseURL}/api/v1/me`)).status()).toBe(401);
  expect(server.output()).toContain('signed out everywhere');
});
