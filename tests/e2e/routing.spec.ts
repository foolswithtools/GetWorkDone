import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// Every SPA view has its own URL (GWP#98): opening a team and then a capture page changes the address,
// a reload shows the same view, Back and Forward move between views inside the app, an item's URL opened
// in another signed-in context shows the item (and, signed out, shows it right after sign-in), and an
// unknown path shows "Not found". The team, work type and item are made through the API.

let server: ApiServer;
const run = randomUUID().slice(0, 8);
const admin = { sub: `e2e-route-admin-${run}`, email: `route-admin-${run}@example.test`, name: `Route admin ${run}` };
const outsider = { sub: `e2e-route-out-${run}`, email: `route-out-${run}@example.test`, name: `Route outsider ${run}` };
const teamName = `Routing ${run}`;
let teamId: string;
let workTypeId: string;
let itemId: string;

test.beforeAll(async ({ browser }) => {
  server = await startApiServer(admin);
  const page = await signIn(browser, admin);
  const csrf = ((await (await page.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  const headers = { 'X-GWD-CSRF': csrf };
  teamId = ((await (await page.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: teamName }, headers })).json()) as { id: string }).id;
  const definition = { fields: [{ key: 'title', label: 'Title', type: 'text', required: true }], steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] };
  const workType = await page.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types`, { data: { slug: 'notes', definition }, headers });
  expect(workType.status()).toBe(201);
  workTypeId = ((await workType.json()) as { id: string }).id;
  const item = await page.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data: { data: { title: 'deep linked' } }, headers });
  expect(item.status()).toBe(201);
  itemId = ((await item.json()) as { id: string }).id;
  await page.context().close();
});

test.afterAll(async () => {
  await server.stop();
});

// GWP#48: no watched page broke a CSP directive or threw (support/csp.ts).
test.afterEach(() => expectNoCspViolations());

async function signIn(browser: Browser, who: typeof admin): Promise<Page> {
  server.issuer.user = who;
  const page = watchCsp(await (await browser.newContext()).newPage());
  await page.goto(`${server.baseURL}/`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(who.name);
  return page;
}

test('each view has its own URL: reload, Back and Forward, deep links and Not found', async ({ browser }) => {
  const page = await signIn(browser, admin);
  // Open the team, then its capture page: the address follows.
  await page.getByRole('button', { name: `Open ${teamName}` }).click();
  await expect(page.locator('#team-title')).toHaveText(teamName);
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}`);
  await page.getByRole('button', { name: 'Capture notes' }).click();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}/work-types/${workTypeId}/capture`);
  await expect(page.getByTestId('capture-form')).toBeVisible();

  // A reload shows the same capture page.
  await page.reload();
  await expect(page.locator('#team-title')).toHaveText(teamName);
  await expect(page.getByTestId('capture-form')).toBeVisible();
  await expect(page.getByTestId('item-row')).toContainText('deep linked');

  // Back shows the team's work types; Forward the capture page again.
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}`);
  await expect(page.getByTestId('work-type-list')).toContainText('notes (version 1)');
  await expect(page.getByTestId('capture-form')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}/work-types/${workTypeId}/capture`);
  await expect(page.getByTestId('capture-form')).toBeVisible();

  // Opening an item from the capture page gives it the item's URL, and its Back returns to the capture page
  // with the status filter it had (one step back in history, not a new entry).
  await page.getByTestId('item-status-filter').selectOption('completed');
  await expect(page.getByTestId('item-row')).toHaveCount(1);
  await page.getByTestId('item-row').getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}/items/${itemId}`);
  await expect(page.getByTestId('item-data')).toContainText('deep linked');
  await page.getByRole('button', { name: 'Back to the items' }).click();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}/work-types/${workTypeId}/capture`);
  await expect(page.getByTestId('item-status-filter')).toHaveValue('completed');
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}`);

  // Members and the builder have their own addresses too, and survive a reload.
  await page.goto(`${server.baseURL}/teams/${teamId}/members`);
  await expect(page.getByTestId('members-panel')).toBeVisible();
  await page.goto(`${server.baseURL}/teams/${teamId}/work-types/${workTypeId}/edit`);
  await expect(page.locator('#builder-title')).toHaveText('Edit notes (next version: 2)');
  await page.goto(`${server.baseURL}/teams/${teamId}/work-types/new`);
  await expect(page.locator('#builder-title')).toHaveText('New work type');

  // Back from the teams list leaves the app.
  await page.goto('about:blank');
  await page.goto(`${server.baseURL}/`);
  await expect(page.getByTestId('team-list')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('about:blank');

  // An unknown path shows Not found, with a link home.
  await page.goto(`${server.baseURL}/no-such-page`);
  await expect(page.getByTestId('not-found')).toContainText('Not found');
  await page.getByTestId('not-found').getByRole('link').click();
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(page.getByTestId('team-list')).toBeVisible();
});

test('an item URL opened in a fresh signed-in context shows the item', async ({ browser }) => {
  const page = await signIn(browser, admin);
  await page.goto(`${server.baseURL}/teams/${teamId}/items/${itemId}`);
  await expect(page.getByTestId('item-view').getByTestId('item-data')).toContainText('deep linked');
  // With no view it was opened from, its Back goes to the team's page.
  await page.getByRole('button', { name: 'Back to the items' }).click();
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}`);
  await expect(page.getByTestId('work-type-list')).toBeVisible();
});

test('an item URL opened signed out shows the item right after sign-in', async ({ browser }) => {
  server.issuer.user = admin;
  const page = watchCsp(await (await browser.newContext()).newPage());
  await page.goto(`${server.baseURL}/teams/${teamId}/items/${itemId}`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(admin.name);
  await expect(page).toHaveURL(`${server.baseURL}/teams/${teamId}/items/${itemId}`);
  await expect(page.getByTestId('item-data')).toContainText('deep linked');
});

test('a team the person is not in, or an unknown item, shows a message rather than a blank page', async ({ browser }) => {
  const page = await signIn(browser, outsider);
  await page.goto(`${server.baseURL}/teams/${teamId}/work-types/${workTypeId}/capture`);
  await expect(page.getByTestId('team-not-found')).toBeVisible();
  const own = await signIn(browser, admin);
  await own.goto(`${server.baseURL}/teams/${teamId}/items/${randomUUID()}`);
  await expect(own.getByRole('alert')).toContainText('Could not load the item');
  await own.goto(`${server.baseURL}/teams/${teamId}/work-types/${randomUUID()}/capture`);
  await expect(own.getByTestId('work-type-not-found')).toBeVisible();
});
