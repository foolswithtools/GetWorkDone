# Publishing snapshots to the public twin

GetWorkDone's code is public and its pipelines are private (spec §3.6). This repository is the source of truth. The public twin, `foolswithtools/GetWorkDone`, gets the code only through snapshot PRs: an admin pushes a release tag here, `.github/workflows/publish.yml` stages the tagged tree through an allowlist, scans it, and opens one squashed PR on the twin. A CODEOWNER there reviews and merges it (D-021, D-022). There is no live mirror, and nothing is published from a branch.

Decisions are cited by number from the program register (`foolswithtools/prebutton` `docs/specs/2026-10-12-prebutton-program.md` §9.4): D-022 (promote by tag), D-024 (the twin's credential-free `ci.yml`), D-035 (the deny-list), D-036 (the publisher App may write `ci.yml`), D-048 (`vX.Y.Z` tags), D-052 (the `publish` environment and the `tags-admin-only` ruleset), D-072 (`vars.` values), D-091 (the publish secrets in Secrets Manager).

## What a snapshot contains

`publish/allowlist.txt` decides. `scripts/publish/snapshot.ts` reads it from the tag it stages, never from a working tree. Each line is one of:

- `<source> <destination>`: publish a file, or a directory (both sides end in `/`). Here the source and the destination are always the same path;
- `!<path>`: never publish this file or directory, even inside a published directory.

Every path that `git ls-tree -r <tag>` lists must match a line, and every line must match a tracked path. Otherwise the snapshot stops and names each problem. So a new file is never published by accident: someone decided. The script also stops when:

- two include lines publish the same path;
- a published entry is a symlink, a submodule or anything other than a regular file;
- a destination falls under `.github/` or is on the keep-list (below);
- the rendered `ci.yml` contains `secrets.`, `id-token` or `pull_request_target` in any case. This is the check `foolswithtools/GetWorkDone`'s `scripts/ci-guard.sh` runs on the PR.

What is published, in short: `apps/`, `packages/`, `observability/`, `specs/`, `docs/` (except `docs/deploy/` and `docs/architecture/`), `tests/e2e/`, `tests/smoke/`, most of `tests/scripts/`, the four scripts the gates and the lint use, `scripts/install-pnpm.sh` and `deploy/rds/` (the RDS CA bundle, #57; the `Dockerfile` needs both), `compose.yaml` with `deploy/local/` (the local trial: Dex's config), and the root build, lint and test configuration. What is not: the workflows and composite actions, the rest of `deploy/`, the infrapipe configs, `docs/deploy/`, `docs/architecture/` (the diagrams draw the deploy shape), the live and deploy-time tests and scripts, `tests/workflows/`, the publish mechanism itself, and the twin's own files. The allowlist gives the reason for each exclusion beside its line.

### Classifying a new path

When `snapshot.ts --check` names a path:

1. Decide whether a stranger could use it without anything private. Code, tests and docs about the app are published. Anything that names a real environment, runs only in a deploy or reads an unpublished file is not.
2. A test inside a published directory that reads an unpublished file breaks the public `ci`. Give it its own `!` line. This is why some of `tests/scripts/` is excluded, for example the tests of the deploy scripts and `tests/scripts/node-version.test.ts`, which reads this repo's `README.md`.
3. A published doc that links an unpublished path has a dead link on the twin. `tests/publish/public-links.test.ts` resolves every relative link in a published doc against the twin's tree (the published paths, the keep-list and `ci.yml`) and names the doc and line of each one that does not resolve. Say in prose that the step is the maintainers' and their notes are private, or drop the link. This is why no published doc links `docs/deploy/`.
4. Add the line with a one-line reason in a comment above it, in the same PR as the new path. `tests/publish/allowlist.test.ts` runs `--check` on `HEAD` in the unit gate, so `ci` fails until the path is classified.
5. To see the public `ci` before a tag, follow "Trying the public tree locally" below.

## What a snapshot does to the twin's tree

The twin owns a few files: in `foolswithtools/GetWorkDone`, its `LICENSE`, `README.md`, `CLAUDE.md`, `.pattern-config.json`, `.github/CODEOWNERS`, and the credential-free floor from GW#1 (`scripts/ci-guard.sh`, `scripts/branch-protection.sh` and their two tests). `publish/keep.txt` lists them. A snapshot commit's tree is:

- those paths, exactly as they are on the twin's `main`;
- plus the staged tree;
- plus `.github/workflows/ci.yml`, written from `publish/templates/ci.yml`.

Every other path on the twin's `main` is deleted. The first snapshot therefore removes `foolswithtools/GetWorkDone`'s floor files `src/index.ts` and `tests/smoke.test.ts`, which `tests/smoke/healthz.test.ts` supersedes. `scripts/publish/snapshot-pr.ts` refuses a staged path that is on the keep-list. It also refuses when a keep-list path is missing from the twin's `main`.

The twin's floor tests run under this repo's `vitest.config.ts` and pass its ESLint. The twin keeps its own `scripts/branch-protection.sh` for two reasons. GW#2 checks that script's literal body. This repo's `tests/scripts/branch-protection.test.ts` exercises options the floor script refuses.

## The public `ci.yml`

`publish/templates/ci.yml` is byte-equal to the twin's `.github/workflows/ci.yml` from GW#1 (the twin's `main` at `dd3dbe6`), so a snapshot shows no workflow diff. It is D-024's workflow:

- the `ci` job on pull requests and on pushes to `main`;
- `permissions: contents: read`, actions pinned by commit, `persist-credentials: false`;
- the guard step `bash scripts/ci-guard.sh`;
- `pnpm install --frozen-lockfile`, `pnpm lint` and `pnpm test:unit`.

Because the published `package.json` is this repo's, the public `pnpm lint` also runs `tsx scripts/state-sync.ts --check`, which reads `docs/context/STATE.md` and `docs/ROADMAP.md`. That is why `docs/context/` is published.

The template needs no `env:` block:

- `packages/db`'s `prisma generate` falls back to a local URL when `DATABASE_URL` is unset;
- the unit tests set the OpenTelemetry variables they depend on themselves.

`tests/publish/ci-template.test.ts` holds the template to D-024: its triggers, its permissions, no credential strings, the three commands, every action pinned, and the pnpm version `package.json` names. When the twin's `ci.yml` changes (GW#3 widens the guard), change the template in the same way, byte for byte. The publisher App writes this one workflow file and no other (D-036).

## Before a tag: the checklist

1. The slices that gate the first public snapshot are merged: the create-team UI, the base stylesheet, the security headers, the output quotas, the dependency gate and the first-team guide. #9's live verification has passed on the commit to be tagged: only code that passed it is tagged.
2. `node scripts/publish/snapshot.ts --check` on that commit exits 0.
3. `pnpm exec vitest run --config vitest.config.ts --coverage.enabled=false tests/docs tests/publish` passes:
   - every repo path the docs cite exists, with its line numbers in range;
   - no published file holds a credential-shaped literal;
   - no published doc links an unpublished path.
4. A reviewer reads `docs/` once for claims about routes and behaviour, which no test checks. For example, a sentence saying a route does not exist yet when it does.
5. The local scans, at least before the first tag. Stage the tag into a scratch directory, then run both scans:

   ```
   git tag v0.1.0 <commit>                  # local only; do not push this one
   node scripts/publish/snapshot.ts v0.1.0 /tmp/snapshot
   mkdir -p /tmp/gitleaks-ignore
   gitleaks dir /tmp/snapshot --no-banner --redact --ignore-gitleaks-allow --gitleaks-ignore-path /tmp/gitleaks-ignore
   bash scripts/publish/check-hygiene.sh /tmp/snapshot --denylist <your copy of the deny-list>
   git tag -d v0.1.0
   ```

   Use gitleaks 8.30.1, the version and checksum pinned in `publish.yml`. Both commands must exit 0.

   Check once that the secret scan can fail at all. Copy `/tmp/snapshot` and plant a made-up token in a file of the copy, for example `ghp_` followed by 36 letters and digits. `gitleaks dir` over the copy must exit non-zero.

   A test fixture that needs a token-shaped value must build it at run time, as `packages/telemetry/src/logger.test.ts` does. The publish scan honours no allow comment.

## Cutting the tag

Tags are an admin act: the `tags-admin-only` ruleset lets only a repository admin create, move or delete one. The `publish` environment accepts only `v*` tag refs (D-052). From an up-to-date `main`:

```
git tag -a v0.1.0 -m "GetWorkDone v0.1.0" <commit on main>
git push origin v0.1.0
```

`publish.yml` then runs once:

- **`verify`** fails unless the tag is `v<x.y.z>` and its commit is on `main`. The trigger's glob `v*.*.*` also admits `v0.1.0-rc1`, which `verify` refuses;
- **`stage`** stages and scans the tag with no environment and no OIDC token;
- **`snapshot`** runs in the `publish` environment;
- each push of a tag gets its own concurrency group, and a run in progress is never cancelled.

Any step of a job with `id-token: write` can request that job's OIDC token, and with it assume the publish role. So the one downloaded binary, gitleaks, runs in `stage`, which has `contents: read` and nothing else: no token and no environment, so none of the `publish` environment's variables. A tampered gitleaks there cannot reach the publish role, the deny-list or the key. `snapshot` runs no downloaded binary.

The `stage` job does this, in order:

1. Stage the tag with `snapshot.ts`.
2. Scan the staged tree with gitleaks. The binary is fetched by release and checked against its sha256. gitleaks reads a `.gitleaks.toml` or a `.gitleaksignore` at the root of the scanned directory, so the step refuses a staged tree that holds either, naming the file, before it fetches gitleaks. With `--ignore-gitleaks-allow` and an empty ignore path, nothing in the tree can silence a finding. gitleaks' built-in rules still skip some paths, among them `pnpm-lock.yaml` and anything under `node_modules/`; `tests/publish/secret-shapes.test.ts` checks every published file, the lockfile included, for credential shapes.
3. Pack the scanned tree into one tarball, and give its sha256 to `snapshot` as a job output.
4. Upload the tarball as the artifact `snapshot-tree`, kept for one day.

The `snapshot` job does this, in order:

1. Download `snapshot-tree` and check it against `stage`'s sha256.
2. Unpack it and refuse anything in it that is not a file or a directory.
3. Stage the tag again with `snapshot.ts`, from this job's own checkout. Refuse unless `diff -r` finds this tree and the scanned one equal, so the tree published is the tree gitleaks scanned. The PR is built from this restaged tree, never from the tarball.
4. Assume the publish role by web identity.
5. Read the deny-list into a file only the runner can read, outside the staged tree. `check-hygiene.sh` runs over the tree, then over the PR body.
6. Read the publisher App key into a file only the runner can read, and mask each of its lines.
7. Open the PR with `snapshot-pr.ts`.

Neither job installs a package. `snapshot.ts` and `snapshot-pr.ts` import only `node:` modules and run under plain `node`, so no dependency's code runs where the token, the deny-list or the key can be reached. Besides them, `snapshot` runs only SHA-pinned GitHub actions (checkout, setup-node, download-artifact and the repository's own web-identity action). A last step removes the deny-list file whatever happened.

The PR is one commit on the twin's `main`, on the branch `snapshot/v<x.y.z>`. Its body names the tag and the source commit. Review and merge it under GW#2's checklist. Nothing in the run merges, closes or deletes anything on the twin.

## The deny-list and the publisher key

Both live in Secrets Manager under `getworkdone/publish/` in the sandbox account. Only the publish role, assumed from the `publish` environment, can read them (D-091). The App id and the role's ARN are variables on the `publish` environment (`PUBLISHER_APP_ID`, `GETWORKDONE_PUBLISH_ROLE_ARN`). No workflow uses the secrets context. The owner's setup steps are in the private `docs/deploy/sandbox.md`, "Owner steps for publishing".

- **`getworkdone/publish/deny-list`** has one string per line. Blank lines and lines starting with `#` are ignored. Each string is matched as a case-insensitive substring. It holds the strings D-035 keeps out of every public repo: the harness domain, the sandbox account id and the AWS role names.
  - Never commit any of them. A finding names the file and the line, never the string.
  - Do not add a string that a snapshot legitimately contains, or every publish fails. One example is this repository's name, which `docs/ROADMAP.md` links. Before adding one, run `check-hygiene.sh` over a staged snapshot.
  - An empty deny-list fails the run (`check-hygiene.sh` exits 2 on one).
- **`getworkdone/publish/publisher-app-key`** holds the publisher App's private key, in PEM. To rotate it:
  1. Generate a new private key in the App's settings.
  2. Put it in the secret with `aws secretsmanager put-secret-value`.
  3. Delete the old key in the App's settings.

  GitHub keeps no copy of a key, so a lost key is replaced in the same way.

## When a run fails

A tag names one commit and is not moved. To publish a fix, merge it and cut the next patch version. To re-run a failed run for the same tag, use "Re-run failed jobs". That is safe, as described under `snapshot` below. The `snapshot-tree` artifact is kept for one day: more than a day later, a re-run of `snapshot` alone finds no artifact, so use "Re-run all jobs", which stages and scans again.

- **`verify`.**
  - "is not v<x.y.z>": a pre-release or misnamed tag. Nothing ran. An admin deletes the tag if it was a mistake.
  - "not on main": the tag names a commit off `main`. Delete the tag and tag a commit on `main`.
- **`stage`, Stage the snapshot.**
  - An unclassified path or a line that matches nothing: classify it ("Classifying a new path"), merge, and tag the next version.
  - "names ... here, not ...": the tag moved between the push and the job. Investigate before anything else.
- **`stage`, Secret scan.** gitleaks found something; `--redact` keeps the value out of the log. Fix the source on `main` and tag the next version.
  - If it is a real credential, revoke it first.
  - If it is a test fixture, build the value at run time.
  - Never weaken the scan.
  - "the staged tree holds a .gitleaks.toml" or "... a .gitleaksignore": a `publish/allowlist.txt` line publishes that file to the snapshot's root. Drop the line, merge, and tag the next version.
- **`snapshot`, Download the scanned tree.** "Artifact not found": the artifact expired after a day, so use "Re-run all jobs".
- **`snapshot`, Stage the snapshot and compare it with the scanned tree.**
  - "gave no sha256", or `sha256sum` reports `FAILED`: the tarball is not the one `stage` packed. Investigate before anything else; do not re-run.
  - "something other than files and directories", or "stages a tree other than the one stage scanned": the tree `stage` scanned is not the tree this checkout stages. Investigate before anything else; do not re-run.
  - "names ... here, not ...": as under `stage`.
- **Web identity**, or an `AccessDenied` reading a secret:
  - the publish environment's `GETWORKDONE_PUBLISH_ROLE_ARN` is unset;
  - or the bootstrap that creates the role was not applied;
  - or the environment has no `v*` tag policy, so it accepts no ref.
- **Deny-list check.**
  - "could not read" with `ResourceNotFoundException`: the secret has no value yet. The owner puts one (owner steps). An `AccessDeniedException` is the web-identity case above.
  - "is empty": the owner fills `getworkdone/publish/deny-list`.
  - A `FINDING`: the published file and line hold a deny-listed string. Remove it on `main` and tag the next version.
- **Open the snapshot PR.**
  - "could not read getworkdone/publish/publisher-app-key": the secret has no value yet, so the owner puts the key.
  - "holds no PEM private key": the owner puts the key in the secret.
  - "`PUBLISHER_APP_ID` is empty": set the environment variable.
  - An HTTP status from GitHub: the call is named and the token never is. A 404 on `/installation` means the App is not installed on the twin.
  - "branch snapshot/v... already exists ...": an earlier run of the same version pushed a different tree, or the twin's `main` moved. A re-run that finds its own branch and tree reuses them, and returns the open PR. Anything else is refused. Check the old branch and its PR by hand before anyone deletes them on the twin.

## Trying the public tree locally

To see the public `ci` before a tag, start from a staged snapshot. Add the twin's keep-list files, read from its `main` (for example with `gh api repos/foolswithtools/GetWorkDone/contents/<path> -H "Accept: application/vnd.github.raw"`). Then run the template's steps in that directory: `bash scripts/ci-guard.sh`, `pnpm install --frozen-lockfile`, `pnpm lint` and `pnpm test:unit`. All four pass on the tree this slice published. Public `ci` runs no `pnpm typecheck`. Run it there too: it type-checks the twin's floor tests under this repo's `tsconfig.json`.
