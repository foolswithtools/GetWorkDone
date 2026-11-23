import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// The request-4-change token through the real routes (GWP#10, docs/r4c.md): the session's identity, its
// team roles from the database, and GET /api/v1/me's r4c field, which tells the SPA to embed the widget.
// The key is generated for the run.

const run = randomUUID().slice(0, 8);
const sub = (name: string) => `r4c-${name}-${run}`;
const APP_ID = 'getworkdone-dev';

async function claims(app: INestApplication, user: SignedIn) {
  const res = await user.get('/api/v1/r4c/token').expect(200);
  expect(res.headers['cache-control']).toBe('no-store');
  const jwks = (await request(app.getHttpServer()).get('/.well-known/r4c-jwks.json').expect(200)).body as JSONWebKeySet;
  return (await jwtVerify(res.body.token as string, createLocalJWKSet(jwks), { algorithms: ['ES256'] })).payload;
}

describe('r4c', () => {
  let app: INestApplication;
  let alice: SignedIn;
  let bob: SignedIn;
  let carol: SignedIn;

  beforeAll(async () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, r4c: { signingKey: pem, appId: APP_ID } });
    await app.init();
    alice = await signIn(app, { subject: sub('alice'), email: 'alice@example.test' });
    bob = await signIn(app, sub('bob'));
    carol = await signIn(app, sub('carol'));
    // alice admins one team and is a member of bob's; bob admins his own two; carol is in none.
    await alice.post('/api/v1/teams', { name: `R4c A ${run}` }).expect(201);
    const teamB = (await bob.post('/api/v1/teams', { name: `R4c B ${run}` }).expect(201)).body.id as string;
    await bob.post('/api/v1/teams', { name: `R4c C ${run}` }).expect(201);
    await bob.post(`/api/v1/teams/${teamB}/members`, { subject: sub('alice'), role: 'member' }).expect(201);
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/r4c/token is 401 without a session', async () => {
    await request(app.getHttpServer()).get('/api/v1/r4c/token').expect(401);
    await request(app.getHttpServer()).get('/api/v1/r4c/token').set('cookie', '__Host-gwd_session=not-a-session').expect(401);
  });

  it('the token carries the identity\'s sub and email, and app_id the instance', async () => {
    const payload = await claims(app, alice);
    expect(payload.sub).toBe(sub('alice'));
    expect(payload.email).toBe('alice@example.test');
    expect(payload.app_id).toBe(APP_ID);
    expect(payload.exp! - payload.iat!).toBe(120);
  });

  it('roles are the distinct roles across the subject\'s teams, sorted: ["admin","member"], ["admin"], or [] for no team', async () => {
    expect((await claims(app, alice)).roles).toEqual(['admin', 'member']);
    expect((await claims(app, bob)).roles).toEqual(['admin']);
    expect((await claims(app, carol)).roles).toEqual([]);
  });

  it('GET /api/v1/me carries r4c.appId, equal to the token\'s app_id', async () => {
    const me = await alice.get('/api/v1/me').expect(200);
    expect(me.body.r4c).toEqual({ appId: APP_ID });
    expect((await claims(app, alice)).app_id).toBe(me.body.r4c.appId);
  });

  describe('with no key', () => {
    let bare: INestApplication;
    let dave: SignedIn;
    beforeAll(async () => {
      bare = await createApp({ webDistDir: fakeWebDist(), logger: false, r4c: { appId: APP_ID } });
      await bare.init();
      dave = await signIn(bare, sub('dave'));
    });
    afterAll(async () => {
      await bare.close();
    });

    it('GET /api/v1/me has no r4c field, so the SPA embeds no widget', async () => {
      const me = await dave.get('/api/v1/me').expect(200);
      expect(me.body).not.toHaveProperty('r4c');
    });

    it('GET /api/v1/r4c/token with a session is 503 r4c_not_configured', async () => {
      const res = await dave.get('/api/v1/r4c/token').expect(503);
      expect(res.body).toEqual({ error: 'r4c_not_configured' });
    });
  });
});
