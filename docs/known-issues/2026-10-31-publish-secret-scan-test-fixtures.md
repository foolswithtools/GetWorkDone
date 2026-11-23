# Fake tokens in a test fixture would have stopped the first publish at the secret scan

Resolved before merge, #11. Nothing was published and no credential was involved: the values were made-up fixtures.

`packages/telemetry/src/logger.test.ts` checks that the logger redacts tokens, and wrote its fake JWT, `ghs_`, `ghp_` and `github_pat_` values as whole string literals. `publish.yml`'s secret scan runs gitleaks over the staged snapshot with `--ignore-gitleaks-allow` and an empty ignore path, so that nothing in the published tree can silence a finding. A staged `v0.1.0` of this branch, scanned locally with the pinned gitleaks 8.30.1, gave two findings in that file (rules `jwt` and `github-app-token`). The first tag would have failed at "Secret scan", after the admin cut it.

Why no test caught it: gitleaks runs only in the publish job, after a tag, and `ci` has no gitleaks.

Fix: the four fixtures are joined at run time, so the source never holds a token-shaped literal and the test checks the same values. A gitleaks scan of the staged tree now reports no leaks.

Regression test: `tests/publish/secret-shapes.test.ts` (unit). It fails when a file the allowlist publishes holds a GitHub token, fine-grained token, JWT, PEM private key or AWS access key id shape. It names the file and line; on the old fixture it named lines 20, 22, 23 and 24. The full gitleaks run is step 5 of the pre-tag checklist in `docs/publishing.md`.
