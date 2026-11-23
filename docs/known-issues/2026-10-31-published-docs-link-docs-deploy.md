# Published docs linked docs/deploy/, which the twin does not get

Resolved in #89, before the first snapshot. Found by the fresh-context whole-branch review of #11. Nothing was published with the dead links.

`publish/allowlist.txt` publishes `docs/` but keeps `docs/deploy/` private (#11). Fifteen relative links in ten published docs pointed at `docs/deploy/sandbox.md`: `docs/context/STATE.md`, `docs/guide/first-team.md`, `docs/observability.md` and seven runbooks. On the public twin every one of them would have been a dead link.

Why no test caught it: `tests/scripts/docs-claims.test.ts` resolves relative links in this repo, where `docs/deploy/sandbox.md` exists.

Fix: each link became prose saying the step is the maintainers' and their deploy notes are private, or was dropped where the sentence stands without it. The link parsing `docs-claims.test.ts` used moved to `tests/publish/markdown-links.ts`, shared by both checks.

Regression test: `tests/publish/public-links.test.ts` (unit), "every relative link in a published doc resolves to a path the twin has". It classifies the index by the allowlist and resolves each published doc's relative links against the twin's tree (the published paths, `publish/keep.txt` and the `ci.yml` the snapshot writes), naming the doc and line of each dead one. On the old docs it named all fifteen.

Not covered: a path named in text, backticked or bare, is not a link, so a published doc can still name an unpublished file without failing this test. The bare mentions of `docs/deploy/sandbox.md` in published docs were reworded in the same change; backticked citations of private paths (for example in `docs/auth.md`) remain, and the pre-tag reviewer reads for them. Link syntaxes the parser does not read (a target with a space or parentheses, a link split across lines) are skipped; no doc uses them.
