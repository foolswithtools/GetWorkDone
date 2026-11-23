# The r4c live spec's widget wait broke on the CSP, then the spec waited on its own outcome promise

Resolved in GWP#105. The spec is #10's owner-run live check (`tests/live/r4c.spec.ts`, `playwright.live.config.ts`). Nothing was exposed and no request was filed: both failures came before the submit.

The owner's first run on 2026-10-31, against `getworkdone-dev` after deploy run 41245857315 (attempt 2, `app-dev` green, every edge check passing), signed in and then failed at line 44:

```
Error: page.waitForFunction: EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'".
```

With that fixed, the second run passed sign-in, the widget's `app-id`, the six tokens and the token route (`200`, `app_id` `getworkdone-dev`), then timed out after 120 s at line 63.

Two causes:

- **The widget wait.** `page.waitForFunction` with a string predicate re-evaluates the string with `eval` inside the page while it polls, and the API's CSP (`script-src 'self'`, no `'unsafe-eval'`, [../security.md](../security.md)) refuses it. Playwright's first check goes through DevTools, outside the CSP, so the call passed whenever the condition was already true. That is why `tests/e2e/r4c.spec.ts:96` and `:113`, with the same predicate, stayed green: the stand-in `widget.js` is defined before the first check. On dev's public page, a string predicate that became true after 1.5 s failed with the same EvalError, while the function form and `expect.poll` over `page.evaluate` passed.
- **The outcome promise.** `page.evaluate` awaits a promise its script evaluates to. The arming script was the assignment `window.__r4cOutcome = new Promise(...)`, whose value is that pending promise, so the evaluate waited for the widget's outcome event, which only the submit on the following lines could send. On dev's page, the same form was still waiting after 4 s; ending the script with `; undefined` returned in 5 ms, and a later read of `window.__r4cOutcome` still resolved.

Why no test caught them: the live spec never runs in CI or from an agent session (D-020), and the e2e spec reads the outcome from the DOM rather than through this promise.

Fix: the three widget waits poll `page.evaluate("customElements.get('r4c-widget') !== undefined")` with `expect.poll`. The tests tsconfig has no DOM lib, which is why these checks are strings. The outcome scripts moved to `tests/live/outcome.ts`, where the arming script ends with `; undefined` and the read deliberately evaluates to the promise.

Regression tests:

- `tests/scripts/playwright-csp.test.ts` (partition: unit): "no spec passes page.waitForFunction a string, which the CSP refuses once it polls" failed before the fix, naming the three sites; "finds a string predicate, and not a function one" pins the scanner.
- `tests/live/outcome.test.ts` (partition: unit): "arming evaluates to undefined, not to the pending promise page.evaluate would wait on" failed against the old script; two more cases check that the read resolves on `r4c-submitted` and on `r4c-error`.
- The live check is the owner's next run of the live spec on `dev`.
