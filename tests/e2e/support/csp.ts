import { expect, type Page } from '@playwright/test';

// The CSP violation listener (GWP#48, docs/security.md): the policy is enforced from the first deploy with
// no report endpoint, so the e2e specs are where a violation shows up. Chromium logs each refusal to the
// console ("Refused to ... because it violates the following Content Security Policy directive"), and a
// refused script often surfaces as a page error too. Watch every page a spec opens, including pages from
// browser.newContext(), then call expectNoCspViolations() at the end of the test.

const seen: string[] = [];

/** Records CSP console messages and page errors from `page` until expectNoCspViolations() is called. */
export function watchCsp(page: Page): Page {
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) seen.push(`console ${message.type()} on ${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => seen.push(`pageerror on ${page.url()}: ${error.message}`));
  return page;
}

/** Asserts no watched page logged a CSP violation or threw, and starts the record afresh. */
export function expectNoCspViolations(): void {
  const recorded = seen.splice(0);
  expect(recorded, 'CSP violations and page errors').toEqual([]);
}
