import { describe, expect, it } from 'vitest';
import { ReadyResponse } from './ready.js';

describe('ReadyResponse', () => {
  it('accepts the two /readyz bodies and nothing in between', () => {
    expect(ReadyResponse.parse({ status: 'ok', database: 'ok' })).toEqual({ status: 'ok', database: 'ok' });
    expect(ReadyResponse.parse({ status: 'degraded', database: 'down' })).toEqual({ status: 'degraded', database: 'down' });
    expect(ReadyResponse.safeParse({ status: 'ok', database: 'down' }).success).toBe(false);
    expect(ReadyResponse.safeParse({ status: 'degraded', database: 'ok' }).success).toBe(false);
    expect(ReadyResponse.safeParse({ status: 'ok' }).success).toBe(false);
  });
});
