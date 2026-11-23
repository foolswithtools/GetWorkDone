# Sign-in cookies and JSON-quoted Authorization values escaped log redaction; discovery could downgrade to http

Resolved before merge, GWP#3. Found by the fresh-context whole-branch review.

## Log redaction gaps

The redacting logger (`packages/telemetry/src/logger.ts`) redacted the session cookie under the `cookie` and `gwd_session` keys, but not a `Cookie: ...; gwd_session=<token>` header written as text, and its `Authorization` text pattern missed a JSON-quoted key (`"authorization":"Basic ..."`). No code logged either as text yet; a later slice that logged a raw header string would have leaked a session token or client credentials.

Fix: a `gwd_session=` / `gwd_login=` text pattern, and the `Authorization` pattern accepts a quoted key.

Regression test: `packages/telemetry/src/logger.test.ts`, "redacts the sign-in cookies and an authorization value written as JSON text (branch review, GWP#3)".

## Discovery endpoints not required to be https

`OidcIdentityProvider` (`apps/api/src/modules/identity/oidc.provider.ts`) required an https issuer but accepted whatever `token_endpoint`, `jwks_uri` and `authorization_endpoint` discovery named. A discovery document naming a plain http token endpoint would have sent the client secret and the PKCE verifier in clear text, and an http `jwks_uri` would have let a network attacker supply the signing keys.

Fix: each discovered endpoint must be https (http only on loopback, for tests), or discovery fails.

Regression test: `apps/api/test/oidc.provider.test.ts`, "refuses discovery whose token or JWKS endpoint is plain http off loopback (branch review)".
