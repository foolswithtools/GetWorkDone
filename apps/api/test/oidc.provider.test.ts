import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityError } from '../src/modules/identity/identity.js';
import { OidcIdentityProvider, oidcConfigFromEnv } from '../src/modules/identity/oidc.provider.js';
import { mockIssuer, S256, type MockIssuer } from './support/mock-issuer.js';

const REDIRECT = 'https://gwd.example.test/auth/callback';
const VERIFIER = 'v'.repeat(43);
const NONCE = 'nonce-1';

// Partition `unit`: the relying party against a local mock issuer on loopback (spec §7.3: auth is on the
// whole-branch review list). Every refusal is an IdentityError with a fixed reason.
describe('OidcIdentityProvider', () => {
  let issuer: MockIssuer;
  let provider: OidcIdentityProvider;

  beforeAll(async () => {
    issuer = await mockIssuer();
  });
  afterAll(() => issuer.close());
  beforeEach(() => {
    provider = new OidcIdentityProvider({ issuerUrl: issuer.issuer, clientId: issuer.clientId, clientSecret: issuer.clientSecret, redirectUri: REDIRECT });
  });

  const code = (overrides: { nonce?: string; codeChallenge?: string } = {}) =>
    issuer.issueCode({ redirectUri: REDIRECT, nonce: NONCE, codeChallenge: S256(VERIFIER), codeChallengeMethod: 'S256', ...overrides });

  async function refusal(promise: Promise<unknown>): Promise<string> {
    const error = await promise.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityError);
    return (error as IdentityError).reason;
  }

  it('builds the authorization URL from discovery: code flow, PKCE S256, state and nonce', async () => {
    const url = new URL(await provider.authorizationUrl({ state: 's1', nonce: 'n1', codeChallenge: 'c1' }));
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer.issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: issuer.clientId, redirect_uri: REDIRECT, scope: 'openid email profile',
      state: 's1', nonce: 'n1', code_challenge: 'c1', code_challenge_method: 'S256',
    });
    expect(provider.name).toBe('oidc');
  });

  it('exchanges a code for the verified identity, and reads discovery once', async () => {
    const before = issuer.hits['/.well-known/openid-configuration'] ?? 0;
    expect(await provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER })).toEqual({ subject: 'user-1', email: 'user1@example.test', displayName: 'User One' });
    await provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER });
    expect(issuer.hits['/.well-known/openid-configuration']).toBe(before + 1);
  });

  it('falls back to preferred_username for the display name and leaves it out when neither is set', async () => {
    issuer.tweakNextToken({ claims: { name: undefined, preferred_username: 'u1' } });
    expect((await provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER })).displayName).toBe('u1');
    issuer.tweakNextToken({ claims: { name: undefined } });
    expect(await provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER })).toEqual({ subject: 'user-1', email: 'user1@example.test' });
  });

  it('rejects a wrong aud', async () => {
    issuer.tweakNextToken({ claims: { aud: 'someone-else' } });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('invalid_id_token');
  });

  it('rejects an aud list naming another authorized party', async () => {
    issuer.tweakNextToken({ claims: { aud: [issuer.clientId, 'other'], azp: 'other' } });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('invalid_id_token');
  });

  it('rejects a wrong iss', async () => {
    issuer.tweakNextToken({ claims: { iss: 'https://evil.example.test' } });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('invalid_id_token');
  });

  it('rejects an expired token, and one with no exp at all', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    issuer.tweakNextToken({ claims: { iat: past - 300, exp: past } });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('invalid_id_token');
    issuer.tweakNextToken({ claims: { exp: undefined } });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('invalid_id_token');
  });

  it('rejects a bad signature', async () => {
    issuer.tweakNextToken({ foreignKey: true });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('invalid_id_token');
  });

  it('rejects a nonce mismatch, and a token with no nonce', async () => {
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: 'another-nonce', codeVerifier: VERIFIER }))).toBe('nonce_mismatch');
    expect(await refusal(provider.exchangeCode({ code: code({ nonce: undefined }), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('nonce_mismatch');
  });

  it('rejects a missing PKCE verifier before calling the issuer, and a wrong one at the token endpoint', async () => {
    const before = issuer.hits['/token'] ?? 0;
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: '' }))).toBe('missing_code_verifier');
    expect(issuer.hits['/token'] ?? 0).toBe(before);
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: 'w'.repeat(43) }))).toBe('token_exchange_failed');
  });

  it('rejects a token with no email', async () => {
    issuer.tweakNextToken({ claims: { email: undefined } });
    expect(await refusal(provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('missing_email');
  });

  it('rejects an unknown or reused code and a wrong client secret at the token endpoint', async () => {
    expect(await refusal(provider.exchangeCode({ code: 'never-issued', nonce: NONCE, codeVerifier: VERIFIER }))).toBe('token_exchange_failed');
    const wrongSecret = new OidcIdentityProvider({ issuerUrl: issuer.issuer, clientId: issuer.clientId, clientSecret: 'nope', redirectUri: REDIRECT });
    expect(await refusal(wrongSecret.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER }))).toBe('token_exchange_failed');
  });

  it('fetches the JWKS again when the issuer rotates its key', async () => {
    await provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER });
    await issuer.rotateKey();
    expect((await provider.exchangeCode({ code: code(), nonce: NONCE, codeVerifier: VERIFIER })).subject).toBe('user-1');
  });

  it('refuses discovery that names another issuer, and an issuer that is unreachable', async () => {
    const lying = new OidcIdentityProvider({ issuerUrl: issuer.issuer, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT }, async (input, init) => {
      const res = await fetch(input, init);
      const body = await res.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, issuer: 'https://evil.example.test' }), { status: 200 });
    });
    expect(await refusal(lying.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }))).toBe('discovery_failed');
    const down = new OidcIdentityProvider({ issuerUrl: 'http://127.0.0.1:1', clientId: 'c', clientSecret: 's', redirectUri: REDIRECT });
    expect(await refusal(down.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }))).toBe('discovery_failed');
  });

  it('refuses discovery whose token or JWKS endpoint is plain http off loopback (branch review)', async () => {
    for (const key of ['token_endpoint', 'jwks_uri', 'authorization_endpoint']) {
      const downgraded = new OidcIdentityProvider({ issuerUrl: issuer.issuer, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT }, async (input, init) => {
        const body = await (await fetch(input, init)).json() as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, [key]: 'http://idp.example.test/x' }), { status: 200 });
      });
      expect(await refusal(downgraded.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })), key).toBe('discovery_failed');
    }
  });

  it('requires https for an issuer that is not on loopback', () => {
    expect(() => new OidcIdentityProvider({ issuerUrl: 'http://idp.example.test', clientId: 'c', clientSecret: 's', redirectUri: REDIRECT })).toThrow(/https/);
    expect(() => new OidcIdentityProvider({ issuerUrl: 'https://idp.example.test/', clientId: 'c', clientSecret: 's', redirectUri: REDIRECT })).not.toThrow();
  });
});

describe('oidcConfigFromEnv', () => {
  const full = { OIDC_ISSUER_URL: 'https://idp.example.test', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_REDIRECT_URI: REDIRECT };

  it('reads the four variables, and is undefined when none is set', () => {
    expect(oidcConfigFromEnv(full)).toEqual({ issuerUrl: 'https://idp.example.test', clientId: 'c', clientSecret: 's', redirectUri: REDIRECT });
    expect(oidcConfigFromEnv({})).toBeUndefined();
  });

  it('throws naming what is missing when only some are set', () => {
    expect(() => oidcConfigFromEnv({ OIDC_ISSUER_URL: 'https://idp.example.test' })).toThrow(/OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI/);
  });
});
