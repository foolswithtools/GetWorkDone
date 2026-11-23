import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { FakeIdentityProvider } from '../src/modules/identity/fake.provider.js';
import { IDENTITY_PROVIDER } from '../src/modules/identity/identity.js';
import { identityProviderFromEnv } from '../src/modules/identity/identity.module.js';
import { OidcIdentityProvider } from '../src/modules/identity/oidc.provider.js';
import { fakeWebDist } from './support/web-dist.js';

const OIDC = { OIDC_ISSUER_URL: 'https://idp.example.test', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_REDIRECT_URI: 'https://gwd.example.test/auth/callback' };

// The fake identity provider signs anyone in as anyone: it must never run outside tests (GWP#3).
describe('fake provider guard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('booting with the fake provider and NODE_ENV=production throws', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('IDENTITY_PROVIDER', 'fake');
    await expect(createApp({ webDistDir: fakeWebDist(), logger: false })).rejects.toThrow(/fake identity provider.*NODE_ENV=test/i);
  });

  it('the fake is refused in every environment but test, and when NODE_ENV is unset', () => {
    for (const NODE_ENV of ['production', 'development', 'staging', '', undefined]) {
      expect(() => identityProviderFromEnv({ IDENTITY_PROVIDER: 'fake', NODE_ENV }), String(NODE_ENV)).toThrow(/NODE_ENV=test/);
    }
    expect(identityProviderFromEnv({ IDENTITY_PROVIDER: 'fake', NODE_ENV: 'test' })).toBeInstanceOf(FakeIdentityProvider);
  });

  it('OIDC is the default; with no OIDC settings sign-in is off rather than the app failing to start', () => {
    expect(identityProviderFromEnv({ ...OIDC, NODE_ENV: 'production' })).toBeInstanceOf(OidcIdentityProvider);
    expect(identityProviderFromEnv({ ...OIDC, IDENTITY_PROVIDER: 'oidc' })).toBeInstanceOf(OidcIdentityProvider);
    expect(identityProviderFromEnv({ NODE_ENV: 'production' })).toBeNull();
  });

  it('an unknown provider name, or half the OIDC settings, stops startup', () => {
    expect(() => identityProviderFromEnv({ IDENTITY_PROVIDER: 'clerk' })).toThrow(/IDENTITY_PROVIDER/);
    expect(() => identityProviderFromEnv({ OIDC_ISSUER_URL: OIDC.OIDC_ISSUER_URL })).toThrow(/OIDC_CLIENT_ID/);
  });

  it('under vitest (NODE_ENV=test, IDENTITY_PROVIDER=fake) the app boots with the fake', async () => {
    const app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    expect(app.get(IDENTITY_PROVIDER)).toBeInstanceOf(FakeIdentityProvider);
    await app.close();
  });
});
