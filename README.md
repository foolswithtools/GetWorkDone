# GetWorkDone

A generic internal business app where teams define their own work as capture
(forms), process (ordered human and automated steps) and distribute (email,
webhook, export), built observability-first. This repository is its public
copy: clone it and use it how you wish.

No application code is published yet; the first arrives with the first
snapshot.

## Quick start

Needs Node 20 (see `.nvmrc`) and pnpm 10 (`npm install --global pnpm@10.32.1`).

```
git clone https://github.com/foolswithtools/GetWorkDone.git
cd GetWorkDone
pnpm install --frozen-lockfile
pnpm lint        # ESLint, then the TypeScript compiler
pnpm test:unit   # Vitest unit tests
```

`bash scripts/ci-guard.sh` checks the workflows (see below); it needs only bash
and grep.

## CI

One workflow, [`.github/workflows/ci.yml`](.github/workflows/ci.yml), runs on
every pull request and every push to `main`: the workflow guard, then
`pnpm lint` and `pnpm test:unit`. It has a read-only token and no credentials,
so there is nothing in it to steal. Integration, end-to-end and deploy gates
run in the private repository, never here.

`scripts/ci-guard.sh [dir]` (default `.github/workflows`) exits 1 and prints
`file:line` for any workflow that references the secrets context, requests an
OIDC token or uses the privileged pull-request trigger, and exits 0 otherwise.
CI runs it before anything else, so a change that adds any of them fails.

## How content arrives

Nothing is committed to this repository directly. Code arrives only as
snapshot pull requests from the private repository: a tagged, allowlisted,
scanned and squashed copy of the published paths, which a maintainer reviews
and merges. There is no live mirror.

`main` is protected; a reviewed pull request with a green `ci` check is the
only way in. The owner applies the protection with:

```
bash scripts/branch-protection.sh foolswithtools/GetWorkDone
gh api repos/foolswithtools/GetWorkDone/branches/main/protection \
  --jq '[.required_status_checks.contexts, .enforce_admins.enabled,
         .required_pull_request_reviews.dismiss_stale_reviews,
         .required_pull_request_reviews.require_last_push_approval]'
# expect [["ci"],true,true,true]
```

Examples use `example.com` and placeholder values for domains, account ids
and role names. Replace them with your own.

## Licence

MIT, see [`LICENSE`](LICENSE).
