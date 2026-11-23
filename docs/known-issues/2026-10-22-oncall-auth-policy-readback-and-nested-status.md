# Live apply.ts would always have exited 1, and a status: outside a feature passed the gate

Resolved before merge, GWP#7. Found by the fresh-context whole-branch review. The tests had missed both apply.ts defects because the in-memory stack accepted and echoed whatever it was sent; it now behaves as the real APIs do in both respects.

**OnCall rejected the token.** `apply.ts` sent `Authorization: Bearer <token>` to OnCall as well as to the stack. OnCall's service-account authentication only accepts a header that starts with the token itself (`glsa_`, `engine/apps/auth_token/auth.py` in grafana/oncall), so the first OnCall request would have been refused 401 on every live run. Fix: the OnCall client sends the bare token, with `X-Grafana-URL` (`auth: 'bare'` in `observability/lib/grafana-client.ts`, used by `observability/apply.ts`). The fake answers 401 to a bearer header on OnCall.

**The policy tree never read back equal.** The team route set `continue: false`. Grafana serialises the tree with `omitempty`, so a false `continue` is not read back. The GET-after-write therefore saw a difference at `routes[0].continue` and exited 1 on every run. Fix: the route leaves `continue` unset, which means false (`observability/alerting/definitions.ts`). The fake drops a false `continue` the way Grafana does.

**A status: outside a feature passed.** `coverage-status.ts` looked for `status` only directly on a feature. One inside a `check:`, on an `out_of_scope` entry or at the top level passed `coverage-check`, although `grep -n "status:"` matched. Fix: any `status` key anywhere in the manifest is a problem (`statusKeys` in `scripts/coverage-status.ts`).

**A status: in a comment passed.** Found by the second review. The YAML parser skips comments, so a line such as `# status: passing` passed `coverage-check` while `grep -n "status:"` matched it. Fix: when the document has no `status` key, every line whose text holds `status:` is a problem too (`statusLines` in `scripts/coverage-status.ts`). The second review also sorted the SLO labels by key, so a read-back that sorts them still matches, and removed a personal handle from a test.

The first review made two smaller changes:
- The OnCall team is picked by exact name from the list, not as the first entry.
- A paginated OnCall list whose next page is on another origin, or that runs past 50 pages, stops the run instead of being cut short silently.

Regression tests:

- `observability/test/apply.test.ts`, "creates every object, reads each back, and points the contact point at the integration it created" (OnCall calls carry the bare token) and "a second run is a no-op" (the tree reads back without a false `continue`).
- `observability/test/definitions.test.ts`, "the policy tree sets no field Grafana leaves out when it reads the tree back (omitempty false)".
- `tests/scripts/coverage-status.test.ts`, "a status: anywhere in the manifest fails coverage-check, not only on a feature" (a nested key, an `out_of_scope` key, a top-level key and a comment).
- `observability/test/apply.test.ts`, "reads the OnCall team by its exact name, not whichever team the list puts first" and "exits 1 rather than act on a list whose next page is on another host".
