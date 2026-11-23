import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL, createPrismaClient, databaseUrl } from './index.js';

describe('databaseUrl', () => {
  it('reads DATABASE_URL and falls back to the local and CI Postgres', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgresql://a:b@db:5432/x' })).toBe('postgresql://a:b@db:5432/x');
    expect(databaseUrl({})).toBe(DEFAULT_DATABASE_URL);
  });
});

describe('createPrismaClient', () => {
  it('creates a client without connecting, with or without the credential re-read (#66)', async () => {
    const plain = createPrismaClient(DEFAULT_DATABASE_URL);
    const rereading = createPrismaClient(DEFAULT_DATABASE_URL, { readSecret: async () => '{}' });
    expect(typeof plain.$queryRaw).toBe('function');
    expect(typeof rereading.$queryRaw).toBe('function');
    await Promise.all([plain.$disconnect(), rereading.$disconnect()]);
  });
});
