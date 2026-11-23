// A stand-in identity provider for tests (GWP#3): it signs in whoever signInAs names, with no issuer.
// identity.module.ts accepts it only under NODE_ENV=test and stops startup anywhere else. It still
// checks what the callback hands it (a code it issued, once; the nonce; the PKCE verifier), so tests
// through the real routes exercise the same flow as OIDC.

import { createHash, randomBytes } from 'node:crypto';
import { IdentityError, type IdentityProvider, type VerifiedIdentity } from './identity.js';

interface Issued { identity: VerifiedIdentity; nonce: string; codeChallenge: string }

export class FakeIdentityProvider implements IdentityProvider {
  readonly name = 'fake';
  private next: VerifiedIdentity = { subject: 'test-user', email: 'test-user@example.test' };
  private readonly codes = new Map<string, Issued>();

  /** The identity the next sign-in returns. */
  signInAs(identity: VerifiedIdentity): void {
    this.next = identity;
  }

  /** Straight back to the callback with a code, as an issuer that needs no consent would answer. */
  async authorizationUrl({ state, nonce, codeChallenge }: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, { identity: this.next, nonce, codeChallenge });
    return `/auth/callback?${new URLSearchParams({ code, state }).toString()}`;
  }

  async exchangeCode({ code, nonce, codeVerifier }: { code: string; nonce: string; codeVerifier: string }): Promise<VerifiedIdentity> {
    const issued = this.codes.get(code);
    this.codes.delete(code);
    if (!issued) throw new IdentityError('token_exchange_failed', 'unknown code');
    if (!codeVerifier || createHash('sha256').update(codeVerifier).digest('base64url') !== issued.codeChallenge) throw new IdentityError('token_exchange_failed', 'PKCE verification failed');
    if (nonce !== issued.nonce) throw new IdentityError('nonce_mismatch');
    return issued.identity;
  }
}
