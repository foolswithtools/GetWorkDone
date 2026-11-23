import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';
import { startSmtpSink, type SmtpSink } from './support/smtp-sink.js';

// Distribution end to end (GWP#6): an admin gives a work type a webhook output aimed at the metadata
// address and an export output in the builder's output editor, sees the webhook's signing secret once,
// captures an item, and the item view's deliveries panel shows the delivery `failed` with
// `blocked_address` (the API runs in production mode, so its worker sends on completion). Then the
// completed item is exported as CSV and downloaded, and a second export at once holds the button (GWP#35).
// An email output added in the builder, as docs/guide/first-team.md's step 5 says, reaches `delivered`
// (GWP#70): the API sends over SMTP to a local sink (support/smtp-sink.ts), since the memory transport
// starts only under NODE_ENV=test, where the worker does not send.

let server: ApiServer;
let smtp: SmtpSink;
const run = randomUUID().slice(0, 8);
const admin = { sub: `e2e-out-admin-${run}`, email: `out-admin-${run}@example.test`, name: `Out admin ${run}` };
const teamName = `Outputs ${run}`;

test.beforeAll(async () => {
  smtp = await startSmtpSink();
  server = await startApiServer(admin, { EMAIL_TRANSPORT: 'smtp', SMTP_URL: smtp.url, EMAIL_FROM: 'getworkdone@example.test' });
});

test.afterAll(async () => {
  await server.stop();
  await smtp.close();
});

// GWP#48: the page breaks no CSP directive and throws nothing (support/csp.ts).
test.beforeEach(({ page }) => {
  watchCsp(page);
});
test.afterEach(() => expectNoCspViolations());

test('a webhook to a blocked address is saved, its secret shown once, and its delivery fails blocked_address; the item exports', async ({ page }) => {
  await page.goto(`${server.baseURL}/`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(admin.name);
  const csrf = ((await (await page.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  expect((await page.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: teamName }, headers: { 'X-GWD-CSRF': csrf } })).status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: `Open ${teamName}` }).click();
  await page.getByTestId('new-work-type').click();

  await page.getByLabel('Slug').fill('tickets');
  const field = page.getByTestId('builder-field').first();
  await field.getByLabel('Label', { exact: true }).fill('Title');
  await field.getByLabel('Key', { exact: true }).fill('title');

  // The default output (keep: persist) becomes a webhook; a second output exports.
  const outputs = page.getByTestId('builder-output');
  await expect(outputs).toHaveCount(1);
  await outputs.nth(0).getByLabel('Kind').selectOption('webhook');
  await outputs.nth(0).getByLabel('URL (https)').fill('http://169.254.169.254/');
  await expect(page.getByTestId('builder-output-0-config-url-error')).toHaveText('Use an https:// URL without a user name or password');
  await expect(page.getByTestId('builder-save')).toBeDisabled();
  // The address is checked when sent to, not here: an https URL to it saves.
  await outputs.nth(0).getByLabel('URL (https)').fill('https://169.254.169.254/');
  await page.getByTestId('outputs-add').click();
  await outputs.nth(1).getByLabel('Kind').selectOption('export');
  await expect(page.getByTestId('builder-errors')).toHaveCount(0);
  await page.getByTestId('builder-save').click();

  await expect(page.getByTestId('webhook-secrets')).toBeVisible();
  await expect(page.getByTestId('webhook-secret-keep')).toHaveText(/^[0-9a-f]{64}$/);
  await page.getByRole('button', { name: 'I have copied them' }).click();
  await expect(page.getByTestId('webhook-secrets')).toHaveCount(0);

  await page.getByRole('button', { name: 'Capture tickets' }).click();
  await page.getByTestId('capture-form').getByLabel(/^Title/).fill('Door sticks');
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('item-row')).toContainText('completed');

  await page.getByTestId('export-generate').click();
  const link = page.getByTestId('export-list').getByRole('link');
  await expect(link).toHaveText(/^CSV, 1 item, /);
  const download = await page.request.get(`${server.baseURL}${await link.getAttribute('href')}`);
  expect(download.status()).toBe(200);
  expect((await download.text()).split('\r\n')[0]).toBe('item_id,completed_at,title');
  // A second export within 30 seconds is refused with 429; the button holds for its Retry-After (GWP#35).
  await page.getByTestId('export-generate').click();
  await expect(page.getByTestId('export-wait')).toHaveText(/^You can export again in \d+ seconds?\.$/);
  await expect(page.getByTestId('export-generate')).toBeDisabled();
  // At 0 the count and the refusal clear and the button is enabled again (at most 30 seconds).
  await expect(page.getByTestId('export-generate')).toBeEnabled({ timeout: 40_000 });
  await expect(page.getByTestId('export-wait')).toHaveCount(0);
  await expect(page.getByTestId('exports').getByRole('alert')).toHaveCount(0);

  await page.getByTestId('item-row').getByRole('button', { name: 'Open' }).click();
  const deliveries = page.getByTestId('item-deliveries');
  await expect(async () => {
    await deliveries.getByRole('button', { name: 'Refresh deliveries' }).click();
    await expect(deliveries.getByTestId('item-delivery')).toHaveAttribute('data-status', 'failed', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(deliveries.getByTestId('item-delivery').locator('[data-col="error"]')).toHaveText('blocked_address');
});

test('an email output added in the builder delivers a completed item', async ({ page }) => {
  const recipient = `requests-${run}@example.test`;
  const emailTeam = `Email ${run}`;
  await page.goto(`${server.baseURL}/`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(admin.name);
  const csrf = ((await (await page.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  expect((await page.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: emailTeam }, headers: { 'X-GWD-CSRF': csrf } })).status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: `Open ${emailTeam}` }).click();
  await page.getByTestId('new-work-type').click();

  await page.getByLabel('Slug').fill('requests');
  const field = page.getByTestId('builder-field').first();
  await field.getByLabel('Label', { exact: true }).fill('Title');
  await field.getByLabel('Key', { exact: true }).fill('title');

  // Keep the persist output; Add output adds a webhook, whose Kind becomes email with one recipient.
  const outputs = page.getByTestId('builder-output');
  await expect(outputs.nth(0).getByLabel('Kind')).toHaveValue('persist');
  await page.getByRole('button', { name: 'Add output' }).click();
  await expect(outputs.nth(1).getByLabel('Kind')).toHaveValue('webhook');
  await outputs.nth(1).getByLabel('Kind').selectOption({ label: 'email: Email each completed item' });
  await outputs.nth(1).getByLabel(/^Recipients/).fill(recipient);
  await expect(page.getByTestId('builder-errors')).toHaveCount(0);
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('work-type-list')).toContainText('requests (version 1)');

  // No steps, so the item completes on capture and the worker sends the email.
  await page.getByRole('button', { name: 'Capture requests' }).click();
  await page.getByTestId('capture-form').getByLabel(/^Title/).fill('New chair');
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('item-row')).toContainText('completed');
  await page.getByTestId('item-row').getByRole('button', { name: 'Open' }).click();
  const deliveries = page.getByTestId('item-deliveries');
  await expect(async () => {
    await deliveries.getByRole('button', { name: 'Refresh deliveries' }).click();
    await expect(deliveries.getByTestId('item-delivery')).toHaveAttribute('data-status', 'delivered', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(deliveries.getByTestId('item-delivery').locator('[data-col="error"]')).toHaveText('');
  expect(smtp.received.filter((mail) => mail.to.includes(recipient))).toHaveLength(1);
  expect(smtp.received.find((mail) => mail.to.includes(recipient))?.data).toContain('Title: New chair');
});
