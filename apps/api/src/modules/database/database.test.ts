import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it } from 'vitest';
import { credentialReread, type SecretsClientLike } from './database.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:rds!db-0example-AbCdEf';

function secrets(answer: { SecretString?: string }): SecretsClientLike & { sent: GetSecretValueCommand[] } {
  const sent: GetSecretValueCommand[] = [];
  return {
    sent,
    send: async (command) => {
      sent.push(command);
      return answer;
    },
  };
}

describe('credentialReread (#66)', () => {
  it('re-reads nothing without DATABASE_CREDENTIALS_SECRET_ARN (local runs and CI)', () => {
    expect(credentialReread({}, () => secrets({}))).toBeUndefined();
  });

  it('reads the master secret by its ARN with GetSecretValue', async () => {
    const client = secrets({ SecretString: '{"username":"getworkdone","password":"rotated"}' });
    const reread = credentialReread({ DATABASE_CREDENTIALS_SECRET_ARN: ARN }, () => client);

    await expect(reread?.readSecret()).resolves.toBe('{"username":"getworkdone","password":"rotated"}');
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.input).toEqual({ SecretId: ARN });
  });

  it('creates the Secrets Manager client only when it first reads', async () => {
    let created = 0;
    const reread = credentialReread({ DATABASE_CREDENTIALS_SECRET_ARN: ARN }, () => ((created += 1), secrets({ SecretString: '{}' })));
    expect(created).toBe(0);
    await reread?.readSecret();
    await reread?.readSecret();
    expect(created).toBe(1);
  });

  it('fails a read that returns no SecretString', async () => {
    const reread = credentialReread({ DATABASE_CREDENTIALS_SECRET_ARN: ARN }, () => secrets({}));
    await expect(reread?.readSecret()).rejects.toThrow('has no SecretString');
  });

  it('logs each re-read without throwing', () => {
    const reread = credentialReread({ DATABASE_CREDENTIALS_SECRET_ARN: ARN }, () => secrets({}));
    expect(() => reread?.onReread?.({ changed: true })).not.toThrow();
    expect(() => reread?.onReread?.({ changed: false })).not.toThrow();
  });
});
