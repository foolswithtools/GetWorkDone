import { generateKeyPairSync } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setIdentity } from '../src/common/identity.js';
import type { Database } from '../src/modules/database/database.js';
import { JwksController } from '../src/modules/r4c/jwks.controller.js';
import { ASSERTION_LIFETIME_SECONDS, R4C_SIGNING_KEY_VARIABLE, loadSigner, r4cOptionsFromEnv, type R4cSigner } from '../src/modules/r4c/signing-key.js';
import { TokenController } from '../src/modules/r4c/token.controller.js';
import { fakeWebDist } from './support/web-dist.js';

// The request-4-change requester assertion (GWP#10, docs/r4c.md): the API signs it with the instance's
// ES256 key and publishes the public key at /.well-known/r4c-jwks.json. Every key here is generated
// for the run; none is ever printed.

const pkcs8 = (key: ReturnType<typeof generateKeyPairSync>['privateKey']) => key.export({ format: 'pem', type: 'pkcs8' }).toString();
const ecKey = () => pkcs8(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
const APP_ID = 'getworkdone-dev';

/** A db whose teamMember.findMany answers `roles` (one row each), recording the query. */
function fakeDb(roles: string[]) {
  const queries: unknown[] = [];
  const db = { client: { teamMember: { findMany: async (query: unknown) => (queries.push(query), roles.map((role) => ({ role }))) } } } as unknown as Database;
  return { db, queries };
}

function signedInRequest(identity = { subject: 'sub-alice', email: 'alice@example.test' }): Request {
  const req = { path: '/api/v1/r4c/token', headers: {} } as Request;
  setIdentity(req, identity, { id: 'session', csrfToken: 'csrf' });
  return req;
}

describe('r4c signing key', () => {
  it('parses a PKCS#8 P-256 PEM; the kid is the RFC 7638 thumbprint of the public JWK', async () => {
    const signer = await loadSigner(ecKey(), APP_ID);
    const { kty, crv, x, y } = signer.publicJwk;
    expect({ kty, crv }).toEqual({ kty: 'EC', crv: 'P-256' });
    expect(signer.kid).toBe(await calculateJwkThumbprint({ kty, crv, x, y }, 'sha256'));
    expect(signer.publicJwk).toEqual({ kty, crv, x, y, alg: 'ES256', use: 'sig', kid: signer.kid });
    expect(signer.appId).toBe(APP_ID);
  });

  it('refuses an RSA key, a PKCS#1 key, a SEC1 EC key, another curve, an encrypted key and garbage, naming R4C_SIGNING_KEY and never the input', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const refused: [string, string][] = [
      ['an RSA PKCS#8 key', pkcs8(rsa)],
      ['an RSA PKCS#1 key', rsa.export({ format: 'pem', type: 'pkcs1' }).toString()],
      ['a SEC1 EC key', p256.export({ format: 'pem', type: 'sec1' }).toString()],
      ['a P-384 key', pkcs8(generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey)],
      ['an encrypted PKCS#8 key', p256.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'x' }).toString()],
      // Built here: a literal PEM header would trip the publish secret scan (tests/publish/secret-shapes.test.ts).
      ['a PKCS#8 header around garbage', ['BEGIN', 'END'].map((edge) => `-----${edge} ${'PRIVATE'} KEY-----`).join('\nbm90IGEga2V5\n')],
      ['garbage', 'not-a-key-but-a-secret-value-1234'],
      ['a public key', p256.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/PRIVATE/g, 'PUBLIC')],
    ];
    for (const [name, pem] of refused) {
      const error = await loadSigner(pem, APP_ID).then(() => undefined, (e: unknown) => e as Error);
      expect(error, name).toBeInstanceOf(Error);
      expect(error!.message, name).toContain(R4C_SIGNING_KEY_VARIABLE);
      for (const line of pem.split('\n').filter((l) => l.length > 8 && !l.startsWith('-----'))) expect(error!.message, name).not.toContain(line);
      expect(error!.message, name).not.toContain(pem.trim());
      expect((error as Error & { cause?: unknown }).cause, `${name}: no cause carries the input`).toBeUndefined();
    }
  });

  it('mints an ES256 JWT under the kid that verifies against the published key set, living 120 s, with the claims edge checks', async () => {
    const signer = await loadSigner(ecKey(), APP_ID);
    const now = Math.floor(Date.now() / 1000);
    const token = await signer.mint({ sub: 'sub-alice', email: 'alice@example.test', roles: ['admin', 'member'] }, now);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: signer.kid, typ: 'JWT' });
    const jwks: JSONWebKeySet = { keys: [signer.publicJwk] };
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { algorithms: ['ES256'] });
    expect(payload).toEqual({ sub: 'sub-alice', email: 'alice@example.test', roles: ['admin', 'member'], app_id: APP_ID, iat: now, exp: now + 120 });
    expect(ASSERTION_LIFETIME_SECONDS).toBe(120);
    expect(payload.exp! - payload.iat!).toBe(120);
  });

  it('refuses to mint without a subject or an email: edge refuses an empty one (requester-assertion.md)', async () => {
    const signer = await loadSigner(ecKey(), APP_ID);
    await expect(signer.mint({ sub: '', email: 'a@example.test', roles: [] })).rejects.toThrow(/sub/);
    await expect(signer.mint({ sub: 'a', email: '', roles: [] })).rejects.toThrow(/email/);
  });

  it('reads R4C_SIGNING_KEY and GETWORKDONE_ENVIRONMENT from the environment; unset or empty is no key, and the app id defaults as telemetry does', () => {
    expect(r4cOptionsFromEnv({ R4C_SIGNING_KEY: 'pem', GETWORKDONE_ENVIRONMENT: 'getworkdone' })).toEqual({ signingKey: 'pem', appId: 'getworkdone' });
    expect(r4cOptionsFromEnv({ R4C_SIGNING_KEY: '', GETWORKDONE_ENVIRONMENT: 'getworkdone-dev' })).toEqual({ appId: 'getworkdone-dev' });
    expect(r4cOptionsFromEnv({})).toEqual({ appId: 'local' });
  });
});

describe('r4c token route (controller)', () => {
  it('without a key is 503 r4c_not_configured, and reads nothing', async () => {
    const { db, queries } = fakeDb(['admin']);
    const error = await new TokenController(null, db).token(signedInRequest()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({ error: 'r4c_not_configured' });
    expect(queries).toEqual([]);
  });

  it('with a key mints for the identity, with its distinct team roles sorted, and app_id the instance', async () => {
    const signer = await loadSigner(ecKey(), APP_ID);
    const { db, queries } = fakeDb(['member', 'admin']);
    const { token } = await new TokenController(signer, db).token(signedInRequest());
    const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [signer.publicJwk] }));
    expect(payload).toMatchObject({ sub: 'sub-alice', email: 'alice@example.test', roles: ['admin', 'member'], app_id: APP_ID });
    expect(queries).toEqual([{ where: { subject: 'sub-alice' }, select: { role: true }, distinct: ['role'] }]);
  });

  it('JwksController publishes the one public key, or none', async () => {
    const signer = await loadSigner(ecKey(), APP_ID);
    expect(new JwksController(signer).jwks()).toEqual({ keys: [signer.publicJwk] });
    expect(new JwksController(null).jwks()).toEqual({ keys: [] });
  });
});

describe('r4c routes in the app', () => {
  let configured: INestApplication;
  let unconfigured: INestApplication;
  let signer: R4cSigner;
  const pem = ecKey();
  beforeAll(async () => {
    signer = await loadSigner(pem, APP_ID);
    configured = await createApp({ webDistDir: fakeWebDist(), logger: false, r4c: { signingKey: pem, appId: APP_ID } });
    await configured.init();
    unconfigured = await createApp({ webDistDir: fakeWebDist(), logger: false, r4c: { appId: APP_ID } });
    await unconfigured.init();
  });
  afterAll(async () => {
    await configured.close();
    await unconfigured.close();
  });

  it('GET /.well-known/r4c-jwks.json is the controller, not the SPA fallback\'s 404: the public key only, cacheable for 300 s', async () => {
    const res = await request(configured.getHttpServer()).get('/.well-known/r4c-jwks.json').expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({ keys: [signer.publicJwk] });
    expect(res.text).not.toContain('"d"');
    const { payload } = await jwtVerify(await signer.mint({ sub: 's', email: 'e@example.test', roles: [] }), createLocalJWKSet(res.body as JSONWebKeySet));
    expect(payload.app_id).toBe(APP_ID);
  });

  it('without a key the key set is empty', async () => {
    const res = await request(unconfigured.getHttpServer()).get('/.well-known/r4c-jwks.json').expect(200);
    expect(res.body).toEqual({ keys: [] });
  });

  it('GET /api/v1/r4c/token without a session is a JSON 401 from the guard, never a redirect, whether or not a key is set', async () => {
    for (const app of [configured, unconfigured]) {
      const res = await request(app.getHttpServer()).get('/api/v1/r4c/token').expect(401);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers.location).toBeUndefined();
    }
  });

  it('a key that is not a PKCS#8 P-256 key stops startup, naming R4C_SIGNING_KEY and not the value', async () => {
    const value = pkcs8(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    const error = await createApp({ webDistDir: fakeWebDist(), logger: false, r4c: { signingKey: value, appId: APP_ID } }).then(async (app) => {
      await app.close();
      return undefined;
    }, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(R4C_SIGNING_KEY_VARIABLE);
    expect(error!.message).not.toContain(value.split('\n')[1]);
  });
});
