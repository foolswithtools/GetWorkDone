import { describe, expect, it } from 'vitest';
import { HealthResponse } from './health.js';

describe('HealthResponse', () => {
  it('accepts the /healthz body and rejects anything else', () => {
    expect(HealthResponse.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(HealthResponse.safeParse({ status: 'down' }).success).toBe(false);
  });
});
