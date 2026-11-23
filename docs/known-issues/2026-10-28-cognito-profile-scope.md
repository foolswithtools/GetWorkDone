# Cognito app client did not allow the profile scope

Resolved in GWP#45, a follow-up from the 2026-10-28 review of `main` at 4374bb4 (deploy and security domains). The code predates it: the request side is GWP#3, the app client GWP#43. Nobody had signed in against Cognito yet, so nothing was exposed and no sign-in was ever refused in practice.

The API asks the issuer for `scope=openid email profile` (`apps/api/src/modules/identity/oidc.provider.ts`, `docs/auth.md`), and `docs/auth.md` tells the installer that the Cognito client needs all three scopes. The data stage's app client (`deploy/sandbox/data/identity-email.tf`) allowed only `openid` and `email`, and its tftest pinned exactly that set. Cognito's hosted UI refuses an authorization request that asks for a scope the client does not allow and redirects to `/auth/callback?error=invalid_scope`, which the API answers 400, so sign-in would have failed for every user on both instances. This is expected from Cognito's documented behaviour, not observed: the first `data-dev` run failed before the client existed.

`profile` is needed: the API reads `name` (else `preferred_username`) into the display name the header shows, and Cognito puts `name` into the ID token only under the `profile` scope.

Why no test caught it: the unit and e2e sign-in tests run against the mock issuer (`apps/api/test/support/mock-issuer.ts`), which accepts any scope, and the tftest checked the stage against its own expectation, not against the API's request. Nothing compares the two trees; such a test is out of scope here.

Fix: the app client allows `openid`, `email` and `profile`. Terraform updates the client in place, so the client id and secret, `getworkdone/<instance>/oidc` and the `/getworkdone/<instance>/data/` handoff parameters do not change. The live check is the owner's, after `data-dev` applies: the hosted UI's authorize URL with `scope=openid+email+profile` answers the login page, not a redirect with `error=invalid_scope` (GWP#45's rollout).

Regression tests:

- `deploy/sandbox/data/tests/identity-email.tftest.hcl`, run "app_client_is_code_grant_with_pkce_scopes_and_one_callback": the client's scopes are exactly `openid`, `email` and `profile` (the `tofu-test` gate, `bash scripts/tofu-test.sh`).
- `apps/api/test/oidc.provider.test.ts` keeps pinning the request side, `scope=openid email profile`, unchanged.
