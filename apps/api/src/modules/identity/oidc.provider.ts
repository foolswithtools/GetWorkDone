// The OIDC relying party (GWP#3): discovery from OIDC_ISSUER_URL, the authorization code flow with PKCE
// (S256), and the ID token checked against the issuer's JWKS with `iss`, `aud`, `exp` and `nonce`
// enforced. It is issuer-agnostic: the sandbox uses Amazon Cognito (D-040), tests a local mock issuer.
//
// Every call to the issuer (discovery, JWKS, token) is outbound HTTP inside withSpan
// (scripts/instrument-lint.ts). The JWKS is fetched here and held as a local key set rather than by
// jose's remote set, so its fetch is spanned too; an unknown `kid` refetches it once (key rotation).

import { withSpan } from '@getworkdone/telemetry';
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { IdentityError, type IdentityProvider, type VerifiedIdentity } from './identity.js';

export interface OidcConfig {
  /** The issuer identifier; discovery is read from `<issuerUrl>/.well-known/openid-configuration`. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** This app's `/auth/callback`, as registered with the issuer. */
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

const ENV_KEYS = { issuerUrl: 'OIDC_ISSUER_URL', clientId: 'OIDC_CLIENT_ID', clientSecret: 'OIDC_CLIENT_SECRET', redirectUri: 'OIDC_REDIRECT_URI' } as const;

/** The OIDC settings from the environment; undefined when none is set, an error when only some are. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv): OidcConfig | undefined {
  const entries = Object.entries(ENV_KEYS).map(([field, key]) => [field, env[key] || undefined] as const);
  const missing = entries.filter(([, value]) => !value).map(([field]) => ENV_KEYS[field as keyof OidcConfig]);
  if (missing.length === entries.length) return undefined;
  if (missing.length > 0) throw new Error(`OIDC sign-in is partly configured; set ${missing.join(', ')}`);
  return Object.fromEntries(entries) as unknown as OidcConfig;
}

/** Issuer identifiers compare without a trailing slash. */
const trimSlash = (url: string) => url.replace(/\/+$/, '');

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** https, or http on loopback (tests). */
function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url));
  } catch {
    return false;
  }
}

/** ID token signature algorithms accepted; `none` and HMAC never are. */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

const CLOCK_TOLERANCE_SECONDS = 30;

export class OidcIdentityProvider implements IdentityProvider {
  readonly name = 'oidc';
  private readonly issuer: string;
  private discovery?: Promise<Discovery>;
  private jwks?: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly config: OidcConfig, private readonly fetchImpl: typeof fetch = fetch) {
    if (!isSecureUrl(config.issuerUrl)) throw new Error('OIDC_ISSUER_URL must use https (http is allowed on loopback only, for tests)');
    this.issuer = trimSlash(config.issuerUrl);
  }

  async authorizationUrl({ state, nonce, codeChallenge }: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const { authorization_endpoint } = await this.discover();
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, nonce, codeVerifier }: { code: string; nonce: string; codeVerifier: string }): Promise<VerifiedIdentity> {
    if (!codeVerifier) throw new IdentityError('missing_code_verifier');
    if (!nonce) throw new IdentityError('nonce_mismatch');
    const discovery = await this.discover();
    const idToken = await this.redeem(discovery, code, codeVerifier);
    const claims = await this.verify(discovery, idToken);
    if (claims.nonce !== nonce) throw new IdentityError('nonce_mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new IdentityError('invalid_id_token', 'ID token has no subject');
    if (typeof claims.email !== 'string' || !claims.email) throw new IdentityError('missing_email', 'ID token has no email (request the email scope)');
    const displayName = typeof claims.name === 'string' && claims.name ? claims.name : typeof claims.preferred_username === 'string' && claims.preferred_username ? claims.preferred_username : undefined;
    return { subject: claims.sub, email: claims.email, ...(displayName ? { displayName } : {}) };
  }

  /** Discovery, read once; a failure is not cached, so the next sign-in tries again. */
  private discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const discovery = withSpan('oidc discovery', async () => {
      const res = await this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`discovery answered ${res.status}`);
      const body = await res.json() as Partial<Discovery>;
      if (typeof body.issuer !== 'string' || trimSlash(body.issuer) !== this.issuer) throw new Error('discovery names another issuer');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        const value = body[key];
        if (typeof value !== 'string') throw new Error(`discovery has no ${key}`);
        // The client secret and the verifier go to the token endpoint, the keys come from jwks_uri.
        if (!isSecureUrl(value)) throw new Error(`discovery ${key} is not https`);
      }
      return body as Discovery;
    }).catch((error: unknown) => {
      this.discovery = undefined;
      throw new IdentityError('discovery_failed', `OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.discovery = discovery;
    return discovery;
  }

  /** The token endpoint call: client_secret_basic unless the issuer only takes client_secret_post. */
  private redeem(discovery: Discovery, code: string, codeVerifier: string): Promise<string> {
    return withSpan('oidc token', async () => {
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: codeVerifier });
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      const methods = discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
      if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
        const credentials = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
      } else {
        form.set('client_id', this.config.clientId);
        form.set('client_secret', this.config.clientSecret);
      }
      const res = await this.fetchImpl(discovery.token_endpoint, { method: 'POST', headers, body: form.toString() });
      const body = await res.json().catch(() => ({})) as { id_token?: unknown; error?: unknown };
      // Only the issuer's error code is kept: the body may echo the code or a token.
      if (!res.ok) throw new IdentityError('token_exchange_failed', `token endpoint answered ${res.status}${typeof body.error === 'string' ? ` ${body.error}` : ''}`);
      if (typeof body.id_token !== 'string') throw new IdentityError('token_exchange_failed', 'token response has no id_token');
      return body.id_token;
    });
  }

  private async verify(discovery: Discovery, idToken: string): Promise<JWTPayload> {
    const options = { issuer: discovery.issuer, audience: this.config.clientId, algorithms: ALGORITHMS, requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: CLOCK_TOLERANCE_SECONDS };
    try {
      let payload: JWTPayload;
      try {
        payload = (await jwtVerify(idToken, await this.keySet(discovery, false), options)).payload;
      } catch (error) {
        if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
        payload = (await jwtVerify(idToken, await this.keySet(discovery, true), options)).payload;
      }
      // With several audiences, the token must have been issued to this client (OIDC Core 3.1.3.7).
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.clientId) throw new Error('azp is not this client');
      return payload;
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError('invalid_id_token', `ID token rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async keySet(discovery: Discovery, refresh: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.jwks && !refresh) return this.jwks;
    const keys = await withSpan('oidc jwks', async () => {
      const res = await this.fetchImpl(discovery.jwks_uri, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new IdentityError('invalid_id_token', `JWKS answered ${res.status}`);
      return await res.json() as JSONWebKeySet;
    });
    this.jwks = createLocalJWKSet(keys);
    return this.jwks;
  }
}
