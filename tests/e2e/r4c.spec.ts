import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startApiServer, type ApiServer } from './support/api-server.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

// The request-4-change widget's embed in the built SPA (GWP#10, docs/r4c.md), under the enforced CSP
// (GWP#48). /__r4c/ is the edge sidecar's in a deploy, so here a stand-in widget.js answers it: a module
// that defines <r4c-widget> as the contract does (open shadow root, an adopted stylesheet, the token-url
// GET with credentials 'same-origin' and redirect 'error', the r4c-submitted and r4c-error events). The
// real widget and edge are the live spec's (tests/live/r4c.spec.ts, owner-run).

const run = randomUUID().slice(0, 8);
const APP_ID = 'getworkdone-e2e';
const user = { sub: `e2e-r4c-${run}`, email: `r4c-${run}@example.test`, name: `R4c ${run}` };

const STAND_IN_WIDGET = `
const sheet = new CSSStyleSheet();
sheet.replaceSync(':host { display: block; } button { color: var(--r4c-color-bg); background: var(--r4c-color-accent); }');
customElements.define('r4c-widget', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    const button = document.createElement('button');
    button.textContent = 'Send';
    button.addEventListener('click', () => this.submit());
    root.append(button);
  }
  async submit() {
    const fail = (error) => this.dispatchEvent(new CustomEvent('r4c-error', { bubbles: true, composed: true, detail: { error } }));
    try {
      const res = await fetch(new URL(this.getAttribute('token-url'), location.href), { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!res.ok) return fail('token_unavailable');
      const { token } = await res.json();
      const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      this.dataset.tokenAppId = claims.app_id;
      this.dispatchEvent(new CustomEvent('r4c-submitted', { bubbles: true, composed: true, detail: { requestId: crypto.randomUUID() } }));
    } catch {
      fail('token_unavailable');
    }
  }
});
`;

let configured: ApiServer;
let bare: ApiServer;

test.beforeAll(async () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  configured = await startApiServer(user, { R4C_SIGNING_KEY: pem, GETWORKDONE_ENVIRONMENT: APP_ID });
  bare = await startApiServer(user);
});

test.afterAll(async () => {
  await configured?.stop();
  await bare?.stop();
});

// GWP#48: no watched page broke a CSP directive or threw (support/csp.ts).
test.afterEach(() => expectNoCspViolations());

/** Counts the requests for /__r4c/widget.js and answers them with the stand-in. */
async function standInWidget(context: BrowserContext): Promise<{ requests: () => number }> {
  let requests = 0;
  await context.route('**/__r4c/widget.js', (route) => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: STAND_IN_WIDGET });
  });
  return { requests: () => requests };
}

async function signIn(browser: Browser, server: ApiServer): Promise<{ page: Page; requests: () => number }> {
  server.issuer.user = user;
  const context = await browser.newContext();
  const widget = await standInWidget(context);
  const page = watchCsp(await context.newPage());
  await page.goto(`${server.baseURL}/`);
  await expect(page.getByTestId('sign-in')).toBeVisible();
  // Signed out, the page loads no widget.
  await expect(page.locator('script[src="/__r4c/widget.js"]')).toHaveCount(0);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(user.name);
  return { page, requests: widget.requests };
}

// A string expression: the e2e tsconfig has no DOM lib. Poll page.evaluate, never page.waitForFunction
// with a string: that one re-evaluates with eval and the CSP refuses it (tests/scripts/playwright-csp.test.ts).
const property = (page: Page, selector: string, name: string) =>
  page.evaluate(`getComputedStyle(document.querySelector('${selector}')).getPropertyValue('${name}').trim()`);

test('signed in on an instance with the key: one widget script, the element with app-id and token-url, the theme\'s tokens, and the submit\'s request id', async ({ browser }) => {
  const { page, requests } = await signIn(browser, configured);
  const widget = page.locator('r4c-widget');
  await expect(widget).toHaveAttribute('app-id', APP_ID);
  await expect(widget).toHaveAttribute('token-url', '/api/v1/r4c/token');
  await expect(page.locator('script[type="module"][src="/__r4c/widget.js"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate("customElements.get('r4c-widget') !== undefined")).toBe(true);

  // The six tokens resolve on the element to the theme's values (r4c-tokens.css from base.css).
  for (const [r4c, gwd] of [['font-family', 'font-family'], ['color-fg', 'color-fg'], ['color-bg', 'color-bg'], ['color-accent', 'color-accent'], ['radius', 'radius'], ['spacing', 'spacing']]) {
    const theme = await property(page, ':root', `--gwd-${gwd}`);
    expect(theme, `--gwd-${gwd}`).not.toBe('');
    expect(await property(page, 'r4c-widget', `--r4c-${r4c}`), `--r4c-${r4c}`).toBe(theme);
  }

  await widget.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('r4c-outcome')).toHaveText(/^Request sent: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await expect(widget).toHaveAttribute('data-token-app-id', APP_ID);
  expect(requests()).toBe(1);
});

test('the token route answers the widget\'s same-origin GET without a session with a JSON 401, which the widget reports', async ({ browser }) => {
  const { page } = await signIn(browser, configured);
  await expect.poll(() => page.evaluate("customElements.get('r4c-widget') !== undefined")).toBe(true);
  await page.context().clearCookies();
  await page.locator('r4c-widget').getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('r4c-outcome')).toHaveText('Request not sent: token_unavailable');
});

test('signed in on an instance without the key: no widget, and no script request', async ({ browser }) => {
  const { page, requests } = await signIn(browser, bare);
  await expect(page.getByTestId('no-teams')).toBeVisible();
  await expect(page.locator('r4c-widget')).toHaveCount(0);
  await expect(page.locator('script[src="/__r4c/widget.js"]')).toHaveCount(0);
  expect(requests()).toBe(0);
});
