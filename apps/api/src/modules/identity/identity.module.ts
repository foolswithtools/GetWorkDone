// Which identity provider the API runs (GWP#3), chosen from the environment when the app is created:
//
//   IDENTITY_PROVIDER=oidc (the default)  OidcIdentityProvider from OIDC_ISSUER_URL, OIDC_CLIENT_ID,
//                                         OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI. With none of them
//                                         set, sign-in is off (null): /auth/login answers 503 and every
//                                         /api/v1 route stays 401, so a deploy before GWP#8 sets them
//                                         exposes nothing. Some but not all of them stops startup.
//   IDENTITY_PROVIDER=fake                FakeIdentityProvider, only under NODE_ENV=test; any other
//                                         NODE_ENV, or none, stops startup.
//
// Another IdP plugs in as a third name here, implementing IdentityProvider (docs/auth.md).

import { Global, Module } from '@nestjs/common';
import { FakeIdentityProvider } from './fake.provider.js';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity.js';
import { OidcIdentityProvider, oidcConfigFromEnv } from './oidc.provider.js';

export function identityProviderFromEnv(env: NodeJS.ProcessEnv): IdentityProvider | null {
  const choice = env.IDENTITY_PROVIDER || 'oidc';
  if (choice === 'fake') {
    if (env.NODE_ENV !== 'test') throw new Error(`The fake identity provider signs anyone in; it runs only with NODE_ENV=test (NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'unset'})`);
    return new FakeIdentityProvider();
  }
  if (choice === 'oidc') {
    const config = oidcConfigFromEnv(env);
    return config ? new OidcIdentityProvider(config) : null;
  }
  throw new Error(`Unknown IDENTITY_PROVIDER "${choice}" (expected oidc or fake)`);
}

@Global()
@Module({
  providers: [{ provide: IDENTITY_PROVIDER, useFactory: () => identityProviderFromEnv(process.env) }],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
