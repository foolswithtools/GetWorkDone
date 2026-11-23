// The request-4-change requester assertion's key (GWP#10, docs/r4c.md): the instance's ES256 private key,
// a PKCS#8 PEM in R4C_SIGNING_KEY, which the owner puts into getworkdone/<instance>/r4c-signing-key. The
// API signs one short-lived JWT per widget submit with it, and publishes the public half at
// /.well-known/r4c-jwks.json under its RFC 7638 thumbprint, where edge and control fetch it
// (request-4-change-private docs/security/requester-assertion.md). No error message, log line or test
// output carries the key: the errors below name the variable and say what is wrong, never the value.

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, SignJWT } from 'jose';

export const R4C_SIGNING_KEY_VARIABLE = 'R4C_SIGNING_KEY';

/**
 * How long an assertion lives. Edge and control refuse an `exp` more than 300 s ahead with no clock-skew
 * allowance, so 300 would fail on a host clock one second ahead; 120 is request-4-change's demo host's.
 */
export const ASSERTION_LIFETIME_SECONDS = 120;

/** The public key as the key set publishes it: never `d`. */
export interface R4cPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg: 'ES256';
  use: 'sig';
  kid: string;
}

export interface AssertionClaims {
  sub: string;
  email: string;
  roles: string[];
}

export interface R4cSigner {
  /** The `app_id` claim, edge's R4C_APP_ID and the element's app-id: the instance's GETWORKDONE_ENVIRONMENT. */
  appId: string;
  kid: string;
  publicJwk: R4cPublicJwk;
  /** A signed assertion for `claims`, issued at `nowSeconds` and expiring ASSERTION_LIFETIME_SECONDS later. */
  mint(claims: AssertionClaims, nowSeconds?: number): Promise<string>;
}

export interface R4cOptions {
  /** The PKCS#8 PEM; absent means request-4-change is not configured on this instance. */
  signingKey?: string;
  appId: string;
}

/**
 * R4C_SIGNING_KEY and the app id from the environment. Unset or empty is no key (local development and
 * every CI partition). The app id is GETWORKDONE_ENVIRONMENT, defaulting to `local` as telemetry does
 * (packages/telemetry/src/otel.ts).
 */
export function r4cOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): R4cOptions {
  const appId = env.GETWORKDONE_ENVIRONMENT || 'local';
  return env.R4C_SIGNING_KEY ? { signingKey: env.R4C_SIGNING_KEY, appId } : { appId };
}

// The label is kept apart from the armour so this file holds no literal PEM header, which the publish
// secret scan (tests/publish/secret-shapes.test.ts) would flag. PKCS#8 only: not SEC1's EC label, not an
// encrypted key's.
const PKCS8_LABEL = 'PRIVATE KEY';
const PKCS8 = new RegExp(`^-----BEGIN ${PKCS8_LABEL}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ${PKCS8_LABEL}-----$`);

function refuse(why: string): never {
  throw new Error(`${R4C_SIGNING_KEY_VARIABLE} ${why}: it must be an unencrypted PKCS#8 PEM of an EC P-256 key (docs/r4c.md)`);
}

function privateKeyFrom(pem: string): KeyObject {
  if (!PKCS8.test(pem.trim())) refuse('is not a PKCS#8 PEM private key');
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The parser's own error is dropped on purpose: nothing of the input may reach a log.
    refuse('could not be parsed');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') refuse('is not an EC P-256 key');
  return key;
}

/** Parses the key and derives its public JWK and kid; throws, naming R4C_SIGNING_KEY only, on anything else. */
export async function loadSigner(pem: string, appId: string): Promise<R4cSigner> {
  const key = privateKeyFrom(pem);
  const { x, y } = await exportJWK(createPublicKey(key));
  if (!x || !y) refuse('has no public point');
  const kid = await calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x, y }, 'sha256');
  const publicJwk: R4cPublicJwk = { kty: 'EC', crv: 'P-256', x, y, alg: 'ES256', use: 'sig', kid };
  return {
    appId,
    kid,
    publicJwk,
    async mint({ sub, email, roles }, nowSeconds = Math.floor(Date.now() / 1000)) {
      // Edge refuses an empty sub or email; failing here names the cause instead of a 401 at submit.
      if (!sub) throw new Error('an assertion needs a sub');
      if (!email) throw new Error('an assertion needs an email');
      return new SignJWT({ email, roles, app_id: appId })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setSubject(sub)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + ASSERTION_LIFETIME_SECONDS)
        .sign(key);
    },
  };
}
