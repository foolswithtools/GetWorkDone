import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #57: the RDS CA bundle the image carries as /app/rds-ca.pem, which both database consumers verify the
// server against (packages/db/src/database-url.ts). A silent edit of the bundle, or a CA close to its
// expiry, fails here rather than at the first connection.
// Published with deploy/rds/ (publish/allowlist.txt), so it imports nothing the twin lacks.
const dir = fileURLToPath(new URL('../../deploy/rds/', import.meta.url));
const SOURCE = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const MIN_DAYS = 90;

const bundle = (): string => readFileSync(join(dir, 'global-bundle.pem'), 'utf8');

/** The PEM blocks in a bundle, each parsed; throws on anything that is not a certificate. */
function certificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new X509Certificate(block));
}

describe('deploy/rds/global-bundle.pem', () => {
  it('matches the committed SHA-256 in global-bundle.pem.sha256', () => {
    const [recorded, name] = readFileSync(join(dir, 'global-bundle.pem.sha256'), 'utf8').trim().split(/\s+/);
    expect(name).toBe('global-bundle.pem');
    expect(createHash('sha256').update(readFileSync(join(dir, 'global-bundle.pem'))).digest('hex')).toBe(recorded);
  });

  it('holds one or more PEM certificates and nothing else', () => {
    const pem = bundle();
    const certs = certificates(pem);
    expect(certs.length).toBeGreaterThan(0);
    // Nothing outside the certificate blocks but whitespace: no key, no stray text.
    expect(pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()).toBe('');
    for (const cert of certs) expect(cert.ca).toBe(true);
  });

  it(`has no certificate expiring within ${MIN_DAYS} days`, () => {
    const limit = Date.now() + MIN_DAYS * 24 * 60 * 60 * 1000;
    const soon = certificates(bundle())
      .filter((cert) => new Date(cert.validTo).getTime() <= limit)
      .map((cert) => `${cert.subject.split('\n').find((l) => l.startsWith('CN=')) ?? cert.subject} (${cert.validTo})`);
    expect(soon).toEqual([]);
  });

  it('is documented in deploy/rds/README.md with its source URL and the refresh command', () => {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain(SOURCE);
    expect(readme).toContain(`curl -fsSL ${SOURCE} -o global-bundle.pem && shasum -a 256 global-bundle.pem > global-bundle.pem.sha256`);
  });
});

// Prisma's engine trusts only the first certificate of its sslcert file, so the migrate task gets the one
// root the instance's CA chains to: rds-ca-rsa2048-g1 in us-east-1, which deploy/sandbox/data/rds.tf pins
// (ca_cert_identifier; its tftest checks the pin). It must be one of the bundle's blocks, unchanged.
describe('deploy/rds/rds-ca-rsa2048-g1-us-east-1.pem', () => {
  const pem = () => readFileSync(join(dir, 'rds-ca-rsa2048-g1-us-east-1.pem'), 'utf8');

  it('holds exactly one certificate, the us-east-1 RSA2048 G1 root, as the bundle has it', () => {
    const certs = certificates(pem());
    expect(certs).toHaveLength(1);
    const [root] = certs as [X509Certificate];
    expect(root.subject.split('\n')).toContain('CN=Amazon RDS us-east-1 Root CA RSA2048 G1');
    expect(root.subject).toBe(root.issuer);
    expect(root.ca).toBe(true);
    expect(certificates(bundle()).map((c) => c.fingerprint256)).toContain(root.fingerprint256);
    expect(new Date(root.validTo).getTime()).toBeGreaterThan(Date.now() + MIN_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe('certificates', () => {
  it('refuses a block that is not a certificate', () => {
    expect(() => certificates('-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n')).toThrow();
  });
});
