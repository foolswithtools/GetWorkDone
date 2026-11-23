import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// Schema builder and capture end to end (GWP#4): an admin builds a three-field work type in the builder,
// a member submits an invalid item (refused in the browser, with the same messages the API returns for
// the same input) and then a valid one, which appears in the item list. Both people sign in through the
// real OIDC flow (support/api-server.ts). The admin creates the team with the team list's form (GWP#49)
// and adds the member in the team's members panel (GWP#20); the spec writes nothing to the database itself.
// Four journeys, run in order in one worker (GWP#59): each builds on the one before, so a failure names
// its journey, and a retry in CI re-runs the group from the first.

test.describe.configure({ mode: 'serial' });

let server: ApiServer;
const run = randomUUID().slice(0, 8);
const admin = { sub: `e2e-admin-${run}`, email: `admin-${run}@example.test`, name: `Admin ${run}` };
const member = { sub: `e2e-member-${run}`, email: `member-${run}@example.test`, name: `Member ${run}` };
const teamName = `Capture ${run}`;

// Set by the journeys in order: the worker's browser keeps both people's pages open between them.
let adminPage: Page;
let page: Page;
let teamId: string;
let workTypeId: string;

test.beforeAll(async () => {
  server = await startApiServer(admin);
});

test.afterAll(async () => {
  await server.stop();
});

test.afterEach(() => {
  expectNoCspViolations();
});

async function signIn(browser: Browser, who: typeof admin): Promise<Page> {
  server.issuer.user = who;
  // GWP#48: every page the spec opens is watched for CSP violations (support/csp.ts).
  const page = watchCsp(await (await browser.newContext()).newPage());
  await page.goto(`${server.baseURL}/`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(who.name);
  return page;
}

async function csrfToken(page: Page): Promise<string> {
  return ((await (await page.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
}

const membersPanel = () => adminPage.getByTestId('members-panel');

test('the admin creates a team and builds a three-field work type: fields, pattern refusal, reorder and preview', async ({ browser }) => {
  // The admin creates a team with the form on the team list (GWP#49), which opens it.
  adminPage = await signIn(browser, admin);
  await adminPage.getByLabel('Team name').fill(teamName);
  const [created] = await Promise.all([
    adminPage.waitForResponse((r) => r.request().method() === 'POST' && r.url() === `${server.baseURL}/api/v1/teams`),
    adminPage.getByTestId('create-team-submit').click(),
  ]);
  expect(created.status()).toBe(201);
  teamId = ((await created.json()) as { id: string }).id;
  await expect(adminPage.locator('#team-title')).toHaveText(teamName);
  await adminPage.getByTestId('new-work-type').click();

  // Three fields: Title (required text, at most 40), Contact (required email), Amount (number, 0 or more).
  await adminPage.getByLabel('Slug').fill('requests');
  const fields = adminPage.getByTestId('builder-field');
  const fill = async (index: number, { label, key, type }: { label: string; key: string; type?: string }) => {
    const field = fields.nth(index);
    await field.getByLabel('Label', { exact: true }).fill(label);
    await field.getByLabel('Key', { exact: true }).fill(key);
    if (type) await field.getByLabel('Type').selectOption(type);
  };
  await fill(0, { label: 'Title', key: 'title' });
  await fields.nth(0).getByLabel('Required').check();
  await fields.nth(0).getByLabel('Maximum length').fill('40');
  await adminPage.getByTestId('builder-add').click();
  await fill(1, { label: 'Contact', key: 'contact', type: 'email' });
  await fields.nth(1).getByLabel('Required').check();
  await adminPage.getByTestId('builder-add').click();
  await fill(2, { label: 'Amount', key: 'amount', type: 'number' });
  await fields.nth(2).getByLabel('Minimum').fill('0');

  // An unsafe pattern is refused in the builder before anything is sent.
  await fields.nth(0).getByLabel(/^Pattern/).fill('(a+)+$');
  await expect(adminPage.getByTestId('builder-field-0-pattern-error')).toHaveText('Pattern could take too long to check: a repeated group contains a repeat');
  await expect(adminPage.getByTestId('builder-save')).toBeDisabled();
  await fields.nth(0).getByLabel(/^Pattern/).fill('');

  // Reorder from the keyboard: Amount moves above Contact, and focus stays with it.
  await adminPage.getByRole('button', { name: 'Move Amount up' }).focus();
  await adminPage.keyboard.press('Enter');
  await expect(fields.nth(1).getByLabel('Label', { exact: true })).toHaveValue('Amount');
  await expect(adminPage.getByTestId('builder-announcement')).toHaveText('Moved Amount to position 2 of 3');
  // GWP#47: the announcement stays in the accessibility tree but takes no space.
  const announcement = await adminPage.getByTestId('builder-announcement').boundingBox();
  expect(announcement?.width).toBeLessThanOrEqual(1);
  expect(announcement?.height).toBeLessThanOrEqual(1);
  await expect(adminPage.getByRole('button', { name: 'Move Amount up' })).toBeFocused();

  // The live preview renders the capture form as built.
  await expect(adminPage.getByTestId('preview-form').getByLabel('Amount')).toBeVisible();
  await adminPage.getByTestId('builder-save').click();
  await expect(adminPage.getByTestId('work-type-list')).toContainText('requests (version 1)');
});

test('the admin adds the member in the members panel; a second add is refused and the last admin stays', async () => {
  // The admin adds the member in the members panel (GWP#20). Adding them twice is refused, and a
  // subject added by mistake is removed again; the admin themself is listed as the team's admin.
  await adminPage.getByTestId('team-members').click();
  const members = membersPanel();
  await expect(members.getByTestId('member-row')).toHaveCount(1);
  await expect(members.getByTestId('member-row')).toContainText([`${admin.sub} admin`]);
  const add = async (subject: string) => {
    await members.getByLabel('Subject').fill(subject);
    await members.getByLabel('Role').selectOption('member');
    await members.getByTestId('members-add').click();
  };
  await add(member.sub);
  await expect(members.getByTestId('member-row')).toHaveCount(2);
  await expect(members.getByTestId('member-row').nth(1)).toContainText(`${member.sub} member`);
  await add(member.sub);
  await expect(members.getByTestId('members-error')).toContainText('already a member of this team');
  await add(`mistake-${run}`);
  await expect(members.getByTestId('member-row')).toHaveCount(3);
  await members.getByRole('button', { name: `Remove mistake-${run}` }).click();
  await expect(members.getByTestId('member-row')).toHaveCount(2);
  // The last admin cannot be removed.
  await members.getByRole('button', { name: `Remove ${admin.sub}` }).click();
  await expect(members.getByTestId('members-error')).toContainText('A team needs an admin');
  await expect(members.getByTestId('member-row')).toHaveCount(2);
  await adminPage.getByTestId('back').click();
  await expect(adminPage.getByTestId('work-type-list')).toBeVisible();
});

test('the member captures an invalid then a valid item, as the API judges it; it completes; a stale version reloads', async ({ browser }) => {
  // The member signs in and opens the capture form.
  page = await signIn(browser, member);
  await page.getByRole('button', { name: `Open ${teamName}` }).click();
  await expect(page.getByTestId('new-work-type')).toHaveCount(0);
  await page.getByRole('button', { name: 'Capture requests' }).click();
  await expect(page.getByTestId('no-items')).toBeVisible();
  const form = page.getByTestId('capture-form');
  await expect(form.locator('label')).toHaveText(['Title (required)', 'Amount', 'Contact (required)']);

  // Invalid: no title, an amount that is not a number, a bad email. The browser refuses it without a request.
  await form.getByLabel('Amount').fill('lots');
  await form.getByLabel(/^Contact/).fill('nope');
  let posted = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/items')) posted += 1;
  });
  await page.getByTestId('capture-submit').click();
  const shown: Record<string, string[]> = {};
  for (const key of ['title', 'amount', 'contact']) shown[key] = await page.getByTestId(`capture-${key}-error`).locator('li').allTextContents();
  expect(shown).toEqual({ title: ['Required'], amount: ['Must be a number'], contact: ['Must be an email address'] });
  expect(posted).toBe(0);

  // The API answers the same input with the same messages.
  const workTypes = (await (await page.request.get(`${server.baseURL}/api/v1/teams/${teamId}/work-types`)).json()) as { id: string }[];
  expect(workTypes).toHaveLength(1);
  workTypeId = workTypes[0]?.id ?? '';
  const res = await page.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data: { data: { amount: 'lots', contact: 'nope' } }, headers: { 'X-GWD-CSRF': await csrfToken(page) } });
  expect(res.status()).toBe(422);
  expect(await res.json()).toEqual({ errors: shown });

  // Valid: the item is created and appears in the list.
  await form.getByLabel(/^Title/).fill('New laptop');
  await form.getByLabel('Amount').fill('1200');
  await form.getByLabel(/^Contact/).fill(member.email);
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('capture-saved')).toBeVisible();
  expect(posted).toBe(1);
  await expect(page.getByTestId('item-row')).toHaveCount(1);
  await expect(page.getByTestId('item-row')).toContainText('New laptop');
  // GWP#47: the .visually-hidden text (base.css) still names the Actions column but takes no space. The
  // header cell is as wide as the column's Open buttons; the hidden span inside it is the 1px clip.
  const actions = page.getByRole('columnheader', { name: 'Actions' });
  await expect(actions).toHaveCount(1);
  const actionsText = await actions.locator('.visually-hidden').boundingBox();
  expect(actionsText?.width).toBeLessThanOrEqual(1);
  expect(actionsText?.height).toBeLessThanOrEqual(1);
  // No steps, so processing (GWP#5) completes it at once.
  await expect(page.getByTestId('item-row')).toContainText('completed');

  // GWP#21: the admin saves version 2 (drops Amount, adds a required Priority) while the member's page
  // still shows version 1. The API refuses the next submit for a key the form does not know, so the page
  // reloads the work type and shows version 2's fields with the API's errors against them.
  const latest = (await (await adminPage.request.get(`${server.baseURL}/api/v1/teams/${teamId}/work-types`)).json()) as { id: string; version: { definition: { fields: { key: string }[] } } }[];
  const v1 = latest[0]?.version.definition as { fields: { key: string }[] };
  const v2 = { ...v1, fields: [...v1.fields.filter((f) => f.key !== 'amount'), { key: 'priority', label: 'Priority', type: 'text', required: true }] };
  const saved = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types/${workTypeId}/versions`, { data: { definition: v2 }, headers: { 'X-GWD-CSRF': await csrfToken(adminPage) } });
  expect(saved.status()).toBe(201);
  await form.getByLabel(/^Title/).fill('Second desk');
  await form.getByLabel(/^Contact/).fill(member.email);
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('capture-version-changed')).toContainText('version 2');
  await expect(form.locator('label')).toHaveText(['Title (required)', 'Contact (required)', 'Priority (required)']);
  await expect(page.getByTestId('capture-priority-error')).toHaveText('Required');
  await expect(form.getByLabel(/^Title/)).toHaveValue('Second desk');
  // The first item was captured under version 1: its Amount shows under the key, in its own column.
  await expect(page.getByTestId('item-list').locator('thead th')).toContainText(['amount']);
  await expect(page.getByTestId('item-row')).toContainText('1200');
  await form.getByLabel(/^Priority/).fill('high');
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('item-row')).toHaveCount(2);
});

test('the item list pages past 100 items, and the admin removes themself once there is a second admin', async () => {
  // The list pages: with more than 100 items, the first page holds 100 and Load more fetches the rest.
  // The member captures 100 more through the API, ten at a time.
  const itemsPath = `${server.baseURL}/api/v1/teams/${teamId}/work-types/${workTypeId}/items`;
  const token = await csrfToken(page);
  for (let batch = 0; batch < 10; batch += 1) {
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => page.request.post(itemsPath, { data: { data: { title: `bulk ${batch * 10 + i}`, contact: member.email, priority: 'low' } }, headers: { 'X-GWD-CSRF': token } })));
    expect(answers.map((a) => a.status())).toEqual(Array(10).fill(201));
  }
  await page.getByTestId('back').click();
  await page.getByRole('button', { name: 'Capture requests' }).click();
  await expect(page.getByTestId('item-row')).toHaveCount(100);
  await page.getByTestId('load-more-items').click();
  await expect(page.getByTestId('item-row')).toHaveCount(102);
  await expect(page.getByTestId('load-more-items')).toHaveCount(0);

  // With a second admin, the first may leave: removing themself takes them back to their team list, without the team.
  // GWP#98: the reload keeps the team's page, at its own address.
  await adminPage.reload();
  await expect(adminPage).toHaveURL(`${server.baseURL}/teams/${teamId}`);
  await expect(adminPage.locator('#team-title')).toHaveText(teamName);
  await adminPage.getByTestId('team-members').click();
  const members = membersPanel();
  await members.getByLabel('Subject').fill(`second-admin-${run}`);
  await members.getByLabel('Role').selectOption('admin');
  await members.getByTestId('members-add').click();
  await expect(members.getByTestId('member-row')).toHaveCount(3);
  await members.getByRole('button', { name: `Remove ${admin.sub}` }).click();
  await expect(adminPage.getByTestId('no-teams')).toBeVisible();
});
