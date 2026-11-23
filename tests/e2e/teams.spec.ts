import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// Team creation and the signed-in subject (GWP#49): a fresh user creates a team from the SPA's form and
// lands on its page as admin; a second user reads their subject from their own header, which is what the
// admin types in the members panel to add them. Both sign in through the real OIDC flow
// (support/api-server.ts); the spec writes nothing to the database itself.

let server: ApiServer;
const run = randomUUID().slice(0, 8);
const founder = { sub: `e2e-founder-${run}`, email: `founder-${run}@example.test`, name: `Founder ${run}` };
// A subject with a character that needs encoding, as some identity providers issue (auth0|...).
const joiner = { sub: `auth0|e2e-joiner-${run}`, email: `joiner-${run}@example.test`, name: `Joiner ${run}` };
// GWP#99: a user whose issuer asserts no name, so the members panel falls back to their email.
const nameless = { sub: `e2e-nameless-${run}`, email: `nameless-${run}@example.test` };
const teamName = `Team ${run}`;

test.beforeAll(async () => {
  server = await startApiServer(founder);
});

test.afterAll(async () => {
  await server.stop();
});

// GWP#48: no watched page broke a CSP directive or threw (support/csp.ts).
test.afterEach(() => expectNoCspViolations());

async function signIn(browser: Browser, who: { sub: string; email: string; name?: string }, permissions: string[] = []): Promise<Page> {
  server.issuer.user = who;
  const context = await browser.newContext();
  if (permissions.length > 0) await context.grantPermissions(permissions, { origin: server.baseURL });
  const page = watchCsp(await context.newPage());
  await page.goto(`${server.baseURL}/`);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(who.name ?? who.email);
  return page;
}

test('a new user creates a team; a member reads their subject from the header and is added by it', async ({ browser }) => {
  // (1) A fresh user has no team; the form's submit stays disabled until the name has more than spaces.
  const page = await signIn(browser, founder);
  await expect(page.getByTestId('no-teams')).toBeVisible();
  const form = page.getByTestId('create-team');
  const submit = form.getByTestId('create-team-submit');
  await expect(submit).toBeDisabled();
  await form.getByLabel('Team name').fill('   ');
  await expect(submit).toBeDisabled();
  await form.getByLabel('Team name').fill(teamName);
  await submit.click();
  // The team page opens without a reload, and /api/v1/me lists the team with the creator as admin.
  await expect(page.locator('#team-title')).toHaveText(teamName);
  await expect(page.getByTestId('team-role')).toHaveText('Your role: admin');
  await expect(page.getByTestId('team-members')).toBeVisible();
  const me = (await (await page.request.get(`${server.baseURL}/api/v1/me`)).json()) as { subject: string; email: string; teams: { name: string; role: string }[] };
  expect(me.teams).toEqual([expect.objectContaining({ name: teamName, role: 'admin' })]);
  // The header shows the exact subject and email /api/v1/me answers.
  await expect(page.getByTestId('my-subject')).toHaveText(me.subject);
  await expect(page.getByTestId('my-email')).toHaveText(me.email);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('team-list')).toContainText(`${teamName} (admin)`);

  // (2) A second user, in their own browser context, reads their subject from their header: the issuer's sub.
  const other = await signIn(browser, joiner, ['clipboard-read', 'clipboard-write']);
  await expect(other.getByTestId('my-subject')).toHaveText(joiner.sub);
  await expect(other.getByTestId('my-email')).toHaveText(joiner.email);
  await expect(other.getByTestId('no-teams')).toBeVisible();
  const subject = (await other.getByTestId('my-subject').textContent())!;

  // (5) Copy subject puts exactly that subject on the clipboard.
  await other.getByTestId('copy-subject').click();
  await expect(other.getByTestId('copy-subject-status')).toHaveText('Copied');
  // A string expression: tests/ is typechecked without the DOM library.
  expect(await other.evaluate('navigator.clipboard.readText()')).toBe(joiner.sub);

  // (3) The founder adds them by that subject, as a member; the second user's reload shows the team.
  await page.getByRole('button', { name: `Open ${teamName}` }).click();
  await page.getByTestId('team-members').click();
  const members = page.getByTestId('members-panel');
  await expect(members).toContainText('in their own header');
  await expect(members).toContainText('Signed in as');
  await members.getByLabel('Subject').fill(subject);
  await members.getByLabel('Role').selectOption('member');
  await members.getByTestId('members-add').click();
  await expect(members.getByTestId('member-row')).toHaveCount(2);
  await expect(members.getByTestId('member-row').nth(1)).toContainText(`${joiner.sub} member`);
  // GWP#99: the joiner signed in once already, so their row leads with the display name their issuer
  // asserted, and the subject stays on the row as its secondary text; the founder's row likewise.
  await expect(members.getByTestId('member-row').nth(1).getByTestId('member-name')).toHaveText(joiner.name);
  await expect(members.getByTestId('member-row').nth(1).getByTestId('member-subject')).toHaveText(joiner.sub);
  await expect(members.getByTestId('member-row').nth(0).getByTestId('member-name')).toHaveText(founder.name);
  await expect(members.getByTestId('member-row').nth(0).getByTestId('member-subject')).toHaveText(founder.sub);
  // Without a name the row leads with the email; a subject that has never signed in shows only itself.
  const namelessPage = await signIn(browser, nameless);
  await namelessPage.context().close();
  for (const sub of [nameless.sub, `e2e-never-${run}`]) {
    await members.getByLabel('Subject').fill(sub);
    await members.getByTestId('members-add').click();
    await expect(members.getByTestId('member-row')).toHaveCount(sub === nameless.sub ? 3 : 4);
  }
  await expect(members.getByTestId('member-row').nth(2).getByTestId('member-name')).toHaveText(nameless.email);
  await expect(members.getByTestId('member-row').nth(2).getByTestId('member-subject')).toHaveText(nameless.sub);
  await expect(members.getByTestId('member-row').nth(3).getByTestId('member-name')).toHaveCount(0);
  await expect(members.getByTestId('member-row').nth(3).getByTestId('member-subject')).toHaveText(`e2e-never-${run}`);
  await other.reload();
  await expect(other.getByTestId('team-list')).toContainText(`${teamName} (member)`);

  // (4) A 121-character name is refused by the API: its message shows under the input, and no team is made.
  await page.getByTestId('back').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('team-list')).toBeVisible();
  await form.getByLabel('Team name').fill('x'.repeat(121));
  await submit.click();
  await expect(form.getByTestId('create-team-name-error')).toContainText('120');
  await expect(form.getByLabel('Team name')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel('Team name')).toHaveValue('x'.repeat(121));
  const teams = (await (await page.request.get(`${server.baseURL}/api/v1/teams`)).json()) as unknown[];
  expect(teams).toHaveLength(1);

  // A failed reread of /api/v1/me after a create still opens the team the API made (review follow-up).
  let aborted = false;
  await page.route('**/api/v1/me', async (route) => {
    if (aborted) return route.continue();
    aborted = true;
    return route.abort();
  });
  await form.getByLabel('Team name').fill(`${teamName} b`);
  await submit.click();
  await expect(page.locator('#team-title')).toHaveText(`${teamName} b`);
  await expect(page.getByTestId('team-role')).toHaveText('Your role: admin');
  expect(aborted).toBe(true);
  await page.unroute('**/api/v1/me');
});
