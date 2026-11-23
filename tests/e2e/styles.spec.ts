import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// The base stylesheet end to end (GWP#47), on the signed-out page of the built app: the theme tokens
// resolve in both colour schemes, the styles come from one linked file with no inline <style> (so the
// security headers can say style-src 'self'), and keyboard focus shows the accent outline.

let server: ApiServer;
const run = randomUUID().slice(0, 8);

test.beforeAll(async () => {
  server = await startApiServer({ sub: `e2e-styles-${run}`, email: `styles-${run}@example.test`, name: `Styles ${run}` });
});

test.afterAll(async () => {
  await server.stop();
});

// GWP#48: the page breaks no CSP directive and throws nothing (support/csp.ts).
test.beforeEach(({ page }) => {
  watchCsp(page);
});
test.afterEach(() => expectNoCspViolations());

// A string expression: the e2e tsconfig has no DOM lib. `name` is one of the literals below.
function token(page: Page, name: string): Promise<string> {
  return page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
}

test('the stylesheet is one linked file whose tokens follow the colour scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${server.baseURL}/`);
  await expect(page.getByTestId('sign-in')).toBeVisible();

  await expect(page.locator('style')).toHaveCount(0);
  await expect(page.locator('link[rel=stylesheet]')).toHaveCount(1);

  const lightAccent = await token(page, '--gwd-color-accent');
  const lightBg = await token(page, '--gwd-color-bg');
  expect(lightAccent).not.toBe('');
  expect(lightBg).not.toBe('');

  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await token(page, '--gwd-color-accent')).not.toBe('');
  const darkBg = await token(page, '--gwd-color-bg');
  expect(darkBg).not.toBe('');
  expect(darkBg).not.toBe(lightBg);
  // The body paints with the token, so the page itself changes scheme.
  await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('keyboard focus on the sign-in link shows the 2px accent outline', async ({ page }) => {
  await page.goto(`${server.baseURL}/`);
  const signIn = page.getByTestId('sign-in');
  await expect(signIn).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(signIn).toBeFocused();
  await expect(signIn).not.toHaveCSS('outline-width', '0px');
  // The base rule, not the browser default (Chromium's default focus ring is 1px auto with a 1px offset).
  await expect(signIn).toHaveCSS('outline-width', '2px');
  await expect(signIn).toHaveCSS('outline-style', 'solid');
  await expect(signIn).toHaveCSS('outline-offset', '2px');
});
