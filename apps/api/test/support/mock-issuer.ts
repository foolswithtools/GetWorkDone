// A local OIDC issuer for tests (GWP#3): discovery, JWKS, an /authorize that signs the configured user
// straight in (302 back to redirect_uri with code and state), and a /token endpoint that checks the
// client secret and the PKCE verifier (S256) and returns an RS256 ID token. Tests can bend the next
// ID token (claims, signing key, header) to prove the relying party refuses it.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';

export interface MockUser { sub: string; email?: string; name?: string }

export interface TokenTweaks {
  /** Claims merged over the defaults; a claim set to undefined is left out. */
  claims?: Record<string, unknown>;
  /** Sign with a key the JWKS does not publish (same kid). */
  foreignKey?: boolean;
}

interface PendingCode { clientId: string; redirectUri: string; nonce?: string; codeChallenge?: string; method?: string; user: MockUser }

export interface MockIssuer {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The user /authorize signs in next. */
  user: MockUser;
  /** Applied to the next ID token only. */
  tweakNextToken(tweaks: TokenTweaks): void;
  /** Mint a code as /authorize would, without the browser round trip. */
  issueCode(args: { redirectUri: string; nonce?: string; codeChallenge?: string; codeChallengeMethod?: string; user?: MockUser }): string;
  /** Rotate the signing key: the JWKS publishes the new key under a new kid. */
  rotateKey(): Promise<void>;
  /** Requests received, by path. */
  hits: Record<string, number>;
  close(): Promise<void>;
}

export const S256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

async function newKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export async function mockIssuer({ clientId = 'gwd-client', clientSecret = 'gwd-client-secret', user = { sub: 'user-1', email: 'user1@example.test', name: 'User One' } as MockUser } = {}): Promise<MockIssuer> {
  let key = await newKey('k1');
  const codes = new Map<string, PendingCode>();
  const hits: Record<string, number> = {};
  let tweaks: TokenTweaks | undefined;
  let issuer = '';

  const state = {
    user,
    issueCode({ redirectUri, nonce, codeChallenge, codeChallengeMethod, user: who }: Parameters<MockIssuer['issueCode']>[0]): string {
      const code = randomBytes(16).toString('base64url');
      codes.set(code, { clientId, redirectUri, nonce, codeChallenge, method: codeChallengeMethod, user: who ?? state.user });
      return code;
    },
  };

  async function idToken(pending: PendingCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { iss: issuer, aud: clientId, sub: pending.user.sub, iat: now, exp: now + 300, nonce: pending.nonce, email: pending.user.email, name: pending.user.name, ...tweaks?.claims };
    const payload = Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined)) as JWTPayload;
    const signingKey: CryptoKey = tweaks?.foreignKey ? (await newKey(key.kid)).privateKey : key.privateKey;
    tweaks = undefined;
    // The claims above carry iat and exp themselves, so tests can set them in the past.
    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' }).sign(signingKey);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        });
      }
      if (url.pathname === '/jwks') return json(res, 200, { keys: [key.jwk] });
      if (url.pathname === '/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || !q.get('redirect_uri')) return json(res, 400, { error: 'invalid_request' });
        const code = state.issueCode({ redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce') ?? undefined, codeChallenge: q.get('code_challenge') ?? undefined, codeChallengeMethod: q.get('code_challenge_method') ?? undefined });
        const back = new URL(q.get('redirect_uri')!);
        back.searchParams.set('code', code);
        if (q.get('state')) back.searchParams.set('state', q.get('state')!);
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        const [id, secret] = basic ? Buffer.from(basic[1]!, 'base64').toString().split(':').map(decodeURIComponent) : [form.get('client_id'), form.get('client_secret')];
        if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: 'invalid_client' });
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (form.get('grant_type') !== 'authorization_code' || !pending || pending.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
        if (pending.codeChallenge) {
          const verifier = form.get('code_verifier');
          if (!verifier || pending.method !== 'S256' || S256(verifier) !== pending.codeChallenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        return json(res, 200, { token_type: 'Bearer', expires_in: 300, access_token: 'opaque-access', id_token: await idToken(pending) });
      }
      json(res, 404, { error: 'not_found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    get user() { return state.user; },
    set user(u: MockUser) { state.user = u; },
    tweakNextToken: (t) => { tweaks = t; },
    issueCode: state.issueCode,
    rotateKey: async () => { key = await newKey(`k${Date.now()}`); },
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
