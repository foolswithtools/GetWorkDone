import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createPrismaClient } from '../../packages/db/src/index.js';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// Processing end to end (GWP#5): an admin adds a member in the Members panel, builds a work type with an
// automated step and a human step in the builder's step editor (the transform's parameter form is
// generated from its Zod params), the member captures an item, which stops at the human step, completes
// that step in the item view, and sees the item `completed` with its history, nothing to deliver and the
// item `completed` in the capture page's list: docs/guide/first-team.md's steps 4 to 8 in order (GWP#70).
// The later tests add the member through POST /api/v1/teams/:teamId/members.

let server: ApiServer;
const db = createPrismaClient();
const run = randomUUID().slice(0, 8);
const admin = { sub: `e2e-proc-admin-${run}`, email: `proc-admin-${run}@example.test`, name: `Proc admin ${run}` };
const member = { sub: `e2e-proc-member-${run}`, email: `proc-member-${run}@example.test`, name: `Proc member ${run}` };
const teamName = `Process ${run}`;

test.beforeAll(async () => {
  server = await startApiServer(admin);
});

test.afterAll(async () => {
  await server.stop();
  await db.$disconnect();
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

test('the first-team guide, steps 4 to 8: add the member, build the work type, capture, complete, see the result', async ({ browser }) => {
  const adminPage = await signIn(browser, admin);
  const csrf = ((await (await adminPage.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  const created = await adminPage.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: teamName }, headers: { 'X-GWD-CSRF': csrf } });
  expect(created.status()).toBe(201);
  await adminPage.reload();
  await adminPage.getByRole('button', { name: `Open ${teamName}` }).click();

  // Guide step 4: the admin adds the member by subject in the Members panel, then goes back to the team.
  await adminPage.getByTestId('team-members').click();
  const members = adminPage.getByTestId('members-panel');
  await expect(members.getByTestId('member-row')).toHaveCount(1);
  await members.getByLabel('Subject').fill(member.sub);
  await members.getByLabel('Role').selectOption('member');
  await members.getByRole('button', { name: 'Add member' }).click();
  await expect(members.getByTestId('member-row')).toHaveCount(2);
  await expect(members.getByTestId('member-row').nth(1)).toContainText(`${member.sub} member`);
  await adminPage.getByTestId('back').click();

  // Guide step 5: one required text field, Title.
  await adminPage.getByTestId('new-work-type').click();
  await adminPage.getByLabel('Slug').fill('orders');
  const field = adminPage.getByTestId('builder-field').first();
  await field.getByLabel('Label', { exact: true }).fill('Title');
  await field.getByLabel('Key', { exact: true }).fill('title');
  await field.getByLabel('Required').check();

  // Steps: a human Review, then an automated Upper-case added after it and moved above it.
  const steps = adminPage.getByTestId('builder-step');
  await adminPage.getByTestId('steps-add-human').click();
  await steps.nth(0).getByLabel('Step name').fill('Review');
  await steps.nth(0).getByLabel('Assignee role').selectOption('member');
  await adminPage.getByTestId('steps-add-automated').click();
  await steps.nth(1).getByLabel('Step name').fill('Upper-case');
  await steps.nth(1).getByLabel('Transform').selectOption('string_case');
  // The parameter form for string_case: a field (text fields only) and the change to make.
  await expect(steps.nth(1).getByLabel('Field').locator('option')).toHaveText(['Choose a field', 'Title']);
  await steps.nth(1).getByLabel('Field').selectOption('title');
  await steps.nth(1).getByLabel('Change').selectOption('upper');
  await adminPage.getByRole('button', { name: 'Move step Upper-case up' }).click();
  await expect(steps.nth(0).getByLabel('Step name')).toHaveValue('Upper-case');
  await expect(adminPage.getByTestId('builder-errors')).toHaveCount(0);
  await adminPage.getByTestId('builder-save').click();
  await expect(adminPage.getByTestId('work-type-list')).toContainText('orders (version 1)');

  // Guide step 6: the member captures an item: the automated step runs, and the item waits at Review.
  const page = await signIn(browser, member);
  await page.getByRole('button', { name: `Open ${teamName}` }).click();
  await page.getByRole('button', { name: 'Capture orders' }).click();
  await page.getByTestId('capture-form').getByLabel(/^Title/).fill('new laptop');
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('item-row')).toHaveCount(1);
  await expect(page.getByTestId('item-row')).toContainText('in_progress');
  await page.getByTestId('item-row').getByRole('button', { name: 'Open' }).click();

  // Guide step 7: the member completes the human step.
  const view = page.getByTestId('item-view');
  await expect(view.getByTestId('item-status')).toHaveText('in_progress');
  await expect(view.getByTestId('item-data')).toContainText('NEW LAPTOP');
  await expect(view.getByTestId('item-step')).toHaveText([/Upper-case.*done/, /Review.*waiting for a member/]);
  await view.getByRole('button', { name: 'Complete Review' }).click();

  await expect(view.getByTestId('item-status')).toHaveText('completed');
  await expect(view.getByTestId('item-step')).toHaveText([/Upper-case.*done/, /Review.*done/]);
  await expect(view.getByRole('button', { name: 'Complete Review' })).toHaveCount(0);
  await expect(view.getByTestId('item-event').locator('[data-col="type"]')).toHaveText(['captured', 'step_started', 'step_completed', 'step_started', 'step_completed', 'completed']);
  await expect(view.getByTestId('item-event').nth(4)).toContainText(member.sub);

  // Guide step 8: with only the persist output there is nothing to deliver, and the item is listed completed.
  await expect(view.getByTestId('item-deliveries').getByTestId('no-deliveries')).toHaveText(/^Nothing to deliver/);
  await view.getByRole('button', { name: 'Back to the items' }).click();
  await expect(page.getByTestId('item-row')).toHaveCount(1);
  await expect(page.getByTestId('item-row')).toContainText('NEW LAPTOP');
  await expect(page.getByTestId('item-row')).toContainText('completed');
});

// GWP#22: an item whose processing stopped between transitions (written here as capture leaves it before
// processing: `open`, one `captured` event) is offered to an admin as Resume, which runs it to its human step.
test('an admin resumes an item whose processing stopped after capture', async ({ browser }) => {
  const adminPage = await signIn(browser, admin);
  const csrf = ((await (await adminPage.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  const headers = { 'X-GWD-CSRF': csrf };
  const resumeTeam = `Resume ${run}`;
  const teamId = ((await (await adminPage.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: resumeTeam }, headers })).json()) as { id: string }).id;
  const definition = {
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
    steps: [
      { id: 'upper', name: 'Upper-case', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'upper' } },
      { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' },
    ],
    outputs: [{ id: 'keep', kind: 'persist', config: {} }],
  };
  const workType = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types`, { data: { slug: 'stuck', definition }, headers });
  expect(workType.status()).toBe(201);
  const versionId = ((await workType.json()) as { version: { id: string } }).version.id;
  const item = await db.item.create({ data: { teamId, workTypeVersionId: versionId, data: { title: 'new laptop' } } });
  await db.itemEvent.create({ data: { itemId: item.id, seq: 1, type: 'captured', actorSubject: admin.sub, payload: { workTypeVersionId: versionId } } });

  await adminPage.reload();
  await adminPage.getByRole('button', { name: `Open ${resumeTeam}` }).click();
  await adminPage.getByRole('button', { name: 'Capture stuck' }).click();
  await adminPage.getByTestId('item-row').getByRole('button', { name: 'Open' }).click();
  const view = adminPage.getByTestId('item-view');
  await expect(view.getByTestId('item-status')).toHaveText('open');
  await view.getByRole('button', { name: 'Resume' }).click();

  await expect(view.getByTestId('item-status')).toHaveText('in_progress');
  await expect(view.getByTestId('item-step')).toHaveText([/Upper-case.*done/, /Review.*waiting for a member/]);
  await expect(view.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await expect(view.getByTestId('item-event').locator('[data-col="type"]')).toHaveText(['captured', 'step_started', 'step_completed', 'step_started']);
});

// GWP#23: an item failed by require_fields is corrected by an admin in the item view's edit form,
// prefilled with its data, and the retry then passes the step to the human one.
test('an admin corrects a failed item\'s data in the item view, then retries it', async ({ browser }) => {
  const adminPage = await signIn(browser, admin);
  const csrf = ((await (await adminPage.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  const headers = { 'X-GWD-CSRF': csrf };
  const editTeam = `Edit data ${run}`;
  const teamId = ((await (await adminPage.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: editTeam }, headers })).json()) as { id: string }).id;
  const definition = {
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }, { key: 'reference', label: 'Reference', type: 'text', required: false }],
    steps: [
      { id: 'need', name: 'Needs a reference', kind: 'automated', transform: 'require_fields', params: { fields: ['reference'] } },
      { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' },
    ],
    outputs: [{ id: 'keep', kind: 'persist', config: {} }],
  };
  const workType = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types`, { data: { slug: 'needs-ref', definition }, headers });
  expect(workType.status()).toBe(201);
  const workTypeId = ((await workType.json()) as { id: string }).id;
  const captured = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data: { data: { title: 'new laptop' } }, headers });
  expect(captured.status()).toBe(201);

  await adminPage.reload();
  await adminPage.getByRole('button', { name: `Open ${editTeam}` }).click();
  await adminPage.getByRole('button', { name: 'Capture needs-ref' }).click();
  await adminPage.getByTestId('item-row').getByRole('button', { name: 'Open' }).click();
  const view = adminPage.getByTestId('item-view');
  await expect(view.getByTestId('item-status')).toHaveText('failed');
  await view.getByRole('button', { name: 'Edit data' }).click();
  // While the form is open the other actions wait.
  await expect(view.getByRole('button', { name: 'Retry Needs a reference' })).toBeDisabled();

  // Another admin's edit lands while the form is open: the save is refused as stale, the form closes with
  // the reason, and the item is reloaded, so the old form's values never overwrite the newer data.
  const itemId = ((await captured.json()) as { id: string }).id;
  const current = (await (await adminPage.request.get(`${server.baseURL}/api/v1/teams/${teamId}/items/${itemId}`)).json()) as { rowVersion: number };
  const elsewhere = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/items/${itemId}/data`, { data: { rowVersion: current.rowVersion, data: { title: 'new laptop (16GB)' } }, headers });
  expect(elsewhere.status()).toBe(200);
  await view.getByTestId('edit-data-form').getByLabel(/^Reference/).fill('PO-0000');
  await view.getByTestId('edit-data-submit').click();
  await expect(view.getByTestId('item-message')).toContainText('changed since it was read');
  await expect(view.getByTestId('item-edit-data')).toHaveCount(0);
  await expect(view.getByTestId('item-data')).toContainText('new laptop (16GB)');
  await view.getByRole('button', { name: 'Edit data' }).click();

  const form = view.getByTestId('edit-data-form');
  await expect(form.getByLabel(/^Title/)).toHaveValue('new laptop (16GB)');
  await expect(form.getByLabel(/^Reference/)).toHaveValue('');
  await form.getByLabel(/^Reference/).fill('PO-7781');
  await view.getByTestId('edit-data-submit').click();
  await expect(view.getByTestId('item-edit-data')).toHaveCount(0);
  await expect(view.getByTestId('item-data')).toContainText('PO-7781');
  await expect(view.getByTestId('item-status')).toHaveText('failed');
  await expect(view.getByTestId('item-event').last()).toContainText('fields changed: reference');

  await view.getByRole('button', { name: 'Retry Needs a reference' }).click();
  await expect(view.getByTestId('item-status')).toHaveText('in_progress');
  await expect(view.getByTestId('item-step')).toHaveText([/Needs a reference.*done/, /Review.*waiting for a member/]);
  await expect(view.getByTestId('item-event').locator('[data-col="type"]')).toHaveText(['captured', 'step_started', 'step_failed', 'data_edited', 'data_edited', 'step_started', 'step_completed', 'step_started']);
});

// GWP#54: an admin gives a human step its decisions in the builder; the member completes it with a
// decision and a comment, which the history shows; the admin cancels a second item with a reason; the
// capture page filtered to `cancelled` lists exactly that item.
test('a decision on a human step, an admin\'s cancel with a reason, and the items filtered by status', async ({ browser }) => {
  const adminPage = await signIn(browser, admin);
  const csrf = ((await (await adminPage.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  const headers = { 'X-GWD-CSRF': csrf };
  const decideTeam = `Decide ${run}`;
  const teamId = ((await (await adminPage.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: decideTeam }, headers })).json()) as { id: string }).id;
  expect((await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/members`, { data: { subject: member.sub, role: 'member' }, headers })).status()).toBe(201);
  await adminPage.reload();
  await adminPage.getByRole('button', { name: `Open ${decideTeam}` }).click();
  await adminPage.getByTestId('new-work-type').click();
  await adminPage.getByLabel('Slug').fill('approvals');
  const field = adminPage.getByTestId('builder-field').first();
  await field.getByLabel('Label', { exact: true }).fill('Title');
  await field.getByLabel('Key', { exact: true }).fill('title');
  await field.getByLabel('Required').check();
  await adminPage.getByTestId('steps-add-human').click();
  const step = adminPage.getByTestId('builder-step').first();
  await step.getByLabel('Step name').fill('Approve');
  // A duplicate decision is refused beside the step before the save.
  await step.getByLabel(/^Decisions/).fill('approve\nreject\napprove');
  await expect(adminPage.getByTestId('builder-step-0-decisions-error')).toHaveText('Duplicate decision "approve"');
  await step.getByLabel(/^Decisions/).fill('approve\nreject');
  await expect(adminPage.getByTestId('builder-step-0-decisions-error')).toHaveCount(0);
  await adminPage.getByTestId('builder-save').click();
  await expect(adminPage.getByTestId('work-type-list')).toContainText('approvals (version 1)');

  // The member captures two items and completes the first with a decision and a comment.
  const page = await signIn(browser, member);
  await page.getByRole('button', { name: `Open ${decideTeam}` }).click();
  await page.getByRole('button', { name: 'Capture approvals' }).click();
  for (const [index, title] of ['first laptop', 'second laptop'].entries()) {
    await page.getByTestId('capture-form').getByLabel(/^Title/).fill(title);
    await page.getByTestId('capture-submit').click();
    await expect(page.getByTestId('item-row')).toHaveCount(index + 1);
  }
  await page.getByTestId('item-row').filter({ hasText: 'first laptop' }).getByRole('button', { name: 'Open' }).click();
  const view = page.getByTestId('item-view');
  await expect(view.getByTestId('item-status')).toHaveText('in_progress');
  await expect(view.getByRole('button', { name: 'Cancel item' })).toHaveCount(0);
  const completion = view.getByTestId('item-completion');
  await expect(completion.getByLabel('Decision').locator('option')).toHaveText(['Choose one', 'approve', 'reject']);
  await completion.getByLabel('Decision').selectOption('approve');
  await completion.getByLabel(/^Comment/).fill('budget ok');
  await view.getByRole('button', { name: 'Complete Approve' }).click();
  await expect(view.getByTestId('item-status')).toHaveText('completed');
  await expect(view.getByTestId('item-event').filter({ hasText: 'step_completed' })).toContainText('Approve (decision: approve; comment: budget ok)');

  // The admin cancels the second item with a reason, after confirming.
  await adminPage.getByRole('button', { name: 'Capture approvals' }).click();
  await adminPage.getByTestId('item-row').filter({ hasText: 'second laptop' }).getByRole('button', { name: 'Open' }).click();
  const adminView = adminPage.getByTestId('item-view');
  await adminView.getByRole('button', { name: 'Cancel item' }).click();
  await adminView.getByTestId('item-cancel').getByLabel(/^Reason/).fill('bought elsewhere');
  await adminView.getByRole('button', { name: 'Confirm cancel' }).click();
  await expect(adminView.getByTestId('item-status')).toHaveText('cancelled');
  await expect(adminView.getByRole('button', { name: 'Cancel item' })).toHaveCount(0);
  await expect(adminView.getByRole('button', { name: 'Complete Approve' })).toHaveCount(0);
  await expect(adminView.getByTestId('item-event').last()).toContainText('reason: bought elsewhere');
  await expect(adminView.getByTestId('item-event').last().locator('[data-col="type"]')).toHaveText('cancelled');

  // Filtered to `cancelled`, the list holds exactly that item; back to all, both.
  await adminView.getByRole('button', { name: 'Back to the items' }).click();
  await expect(adminPage.getByTestId('item-row')).toHaveCount(2);
  await adminPage.getByTestId('item-status-filter').selectOption('cancelled');
  await expect(adminPage.getByTestId('item-row')).toHaveCount(1);
  await expect(adminPage.getByTestId('item-row')).toContainText('second laptop');
  await expect(adminPage.getByTestId('item-row')).toContainText('cancelled');
  await adminPage.getByTestId('item-status-filter').selectOption('failed');
  await expect(adminPage.getByTestId('no-items')).toHaveText('No failed items.');
  await adminPage.getByTestId('item-status-filter').selectOption('');
  await expect(adminPage.getByTestId('item-row')).toHaveCount(2);
});

// GWP#55: the member's team page lists the items waiting for them under "Waiting for you", across the
// team's work types, with the count; completing one from there drops the count. The admin archives a work
// type: a capture page already open on it refuses the next item, and the work type moves to the collapsed
// Archived section, where its items stay readable and Unarchive brings it back.
test('the waiting-for-me queue on the team page, and archiving a work type', async ({ browser }) => {
  const adminPage = await signIn(browser, admin);
  const csrf = ((await (await adminPage.request.get(`${server.baseURL}/api/v1/me`)).json()) as { csrfToken: string }).csrfToken;
  const headers = { 'X-GWD-CSRF': csrf };
  const queueTeam = `Queue ${run}`;
  const teamId = ((await (await adminPage.request.post(`${server.baseURL}/api/v1/teams`, { data: { name: queueTeam }, headers })).json()) as { id: string }).id;
  expect((await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/members`, { data: { subject: member.sub, role: 'member' }, headers })).status()).toBe(201);
  const definition = (assigneeRole: 'member' | 'admin') => ({
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
    steps: [{ id: 'review', name: 'Review', kind: 'human', assigneeRole }],
    outputs: [{ id: 'keep', kind: 'persist', config: {} }],
  });
  const ids: Record<string, string> = {};
  for (const [slug, role] of [['laptops', 'member'], ['desks', 'member'], ['budgets', 'admin']] as const) {
    const created = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types`, { data: { slug, definition: definition(role) }, headers });
    expect(created.status()).toBe(201);
    ids[slug] = ((await created.json()) as { id: string }).id;
  }
  for (const [slug, title] of [['laptops', 'new laptop'], ['desks', 'standing desk'], ['budgets', 'q4 budget']] as const) {
    const captured = await adminPage.request.post(`${server.baseURL}/api/v1/teams/${teamId}/work-types/${ids[slug]}/items`, { data: { data: { title } }, headers });
    expect(captured.status()).toBe(201);
  }

  // The member's queue: the two member steps, not the admin's.
  const page = await signIn(browser, member);
  await page.getByRole('button', { name: `Open ${queueTeam}` }).click();
  const waiting = page.getByTestId('waiting-for-you');
  await expect(waiting.getByTestId('waiting-count')).toHaveText('2');
  await expect(waiting.getByTestId('waiting-row')).toHaveCount(2);
  await expect(waiting.getByTestId('waiting-row').nth(0)).toContainText('standing desk');
  await expect(waiting.getByTestId('waiting-row').nth(1)).toContainText('new laptop');
  await waiting.getByTestId('waiting-row').filter({ hasText: 'new laptop' }).getByRole('button', { name: 'Open' }).click();
  const view = page.getByTestId('item-view');
  await expect(view.getByTestId('item-data')).toContainText('new laptop');
  await view.getByRole('button', { name: 'Complete Review' }).click();
  await expect(view.getByTestId('item-status')).toHaveText('completed');
  await view.getByRole('button', { name: 'Back to the items' }).click();
  await expect(page.getByTestId('waiting-for-you').getByTestId('waiting-count')).toHaveText('1');
  await expect(page.getByTestId('waiting-row')).toHaveCount(1);

  // The admin sees their own step's item and the member's remaining one.
  await adminPage.reload();
  await adminPage.getByRole('button', { name: `Open ${queueTeam}` }).click();
  await expect(adminPage.getByTestId('waiting-for-you').getByTestId('waiting-count')).toHaveText('2');

  // The member opens the desks capture page; the admin archives desks; the member's next item is refused.
  await page.getByRole('button', { name: 'Capture desks' }).click();
  await adminPage.getByRole('button', { name: 'Archive desks' }).click();
  await expect(adminPage.getByTestId('work-type-list')).not.toContainText('desks');
  await page.getByTestId('capture-form').getByLabel(/^Title/).fill('another desk');
  await page.getByTestId('capture-submit').click();
  await expect(page.getByTestId('capture-form-errors')).toHaveText('This work type is archived');

  // Archived, it sits in the collapsed section; its items are still listed, with no capture form.
  const archived = adminPage.getByTestId('archived-work-types');
  await expect(archived.getByRole('button', { name: 'Unarchive desks' })).toBeHidden();
  await archived.getByText('Archived work types (1)').click();
  await archived.getByRole('button', { name: 'Items of desks' }).click();
  await expect(adminPage.getByTestId('capture-archived')).toContainText('archived');
  await expect(adminPage.getByTestId('capture-form')).toHaveCount(0);
  await expect(adminPage.getByTestId('item-row')).toHaveCount(1);
  await adminPage.getByTestId('back').click();
  await adminPage.getByTestId('archived-work-types').getByText('Archived work types (1)').click();
  await adminPage.getByRole('button', { name: 'Unarchive desks' }).click();
  await expect(adminPage.getByTestId('work-type-list')).toContainText('desks');
  await expect(adminPage.getByTestId('archived-work-types')).toHaveCount(0);
});
