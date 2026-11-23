# The publish secret scan honoured a .gitleaksignore at the staged root

Resolved in #92. Found by the post-merge review of #11 (PR #90), still open after #88. No such file was ever tracked or staged, so nothing was silenced.

The `stage` job's Secret scan runs gitleaks 8.30.1 with `--ignore-gitleaks-allow`, an empty `--gitleaks-ignore-path` and a refused `.gitleaks.toml`, and `docs/publishing.md` said nothing in the tree could silence a finding. gitleaks also reads a `.gitleaksignore` at the root of the directory it scans. In the review, a planted `ghp_` token was reported; with its fingerprint written to `<staged>/.gitleaksignore`, the same run reported no leaks. The same file in a subdirectory had no effect. Such a file could only reach the staged root through a reviewed `publish/allowlist.txt` line, so this was defence in depth, not a live leak.

Fix: the step refuses `$staged/.gitleaksignore` beside `$staged/.gitleaks.toml`, exiting 1 and naming the file, before it fetches gitleaks. `docs/publishing.md` says both are refused, and that gitleaks' built-in rules skip some paths, among them `pnpm-lock.yaml` and `node_modules/`, which `tests/publish/secret-shapes.test.ts` covers for the published files.

Regression test: `tests/workflows/publish-guards.test.ts` (unit), "secret scan > refuses a .gitleaksignore at the staged root before it fetches gitleaks" (and the same for `.gitleaks.toml`). It runs the step as written over a fixture staged tree with a `curl` on PATH that records being called, and checks the exit status, the named file and that nothing was fetched. A `.gitleaksignore` in a subdirectory does not stop the step.

Not covered: the test does not run gitleaks itself, so a future gitleaks version that reads another file from the scanned tree would not be caught here; the version is pinned, and a bump should recheck what it reads.
