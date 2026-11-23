// The identity interface (GWP#3): sign-in sits behind it so Clerk or an enterprise IdP plugs in
// (prebutton.md:318). OidcIdentityProvider (oidc.provider.ts) is the one the API runs; the fake
// (fake.provider.ts) exists only under NODE_ENV=test. docs/auth.md describes the flow.

export interface VerifiedIdentity { subject: string; email: string; displayName?: string }
export interface IdentityProvider {
  readonly name: string;
  authorizationUrl(args: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  exchangeCode(args: { code: string; nonce: string; codeVerifier: string }): Promise<VerifiedIdentity>;
}
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

/**
 * Why a sign-in was refused. The reason is a fixed code, safe to log and to return; the detail never
 * carries a token or a code.
 */
export class IdentityError extends Error {
  constructor(readonly reason: string, message = reason) {
    super(message);
    this.name = 'IdentityError';
  }
}
