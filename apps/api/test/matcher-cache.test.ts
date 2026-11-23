import type { CaptureField } from '@getworkdone/contracts';
import { describe, expect, it, vi } from 'vitest';
import { MATCHER_CACHE_SIZE, MatcherCache } from '../src/modules/capture/matcher-cache.js';

// Unit partition: the bounded per-version cache of compiled capture validators (GWP#21).
const fields: CaptureField[] = [{ key: 'code', label: 'Code', type: 'text', required: true, pattern: '[A-Z]{3}' }];
const version = (id: string) => ({ id, definition: { fields } });

describe('MatcherCache', () => {
  it('builds a version\'s validator once and validates with it', () => {
    const build = vi.fn((f: CaptureField[]) => (input: unknown) => ({ ok: false as const, errors: { [f[0]?.key ?? '']: [String(input)] } }));
    const cache = new MatcherCache(4, build);
    expect(cache.validate(version('v1'), 'a')).toEqual({ ok: false, errors: { code: ['a'] } });
    cache.validate(version('v1'), 'b');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('holds at most its capacity, evicting the least recently used version', () => {
    const build = vi.fn(() => () => ({ ok: true as const, data: {} }));
    const cache = new MatcherCache(2, build);
    cache.validate(version('v1'), {});
    cache.validate(version('v2'), {});
    cache.validate(version('v1'), {}); // v1 is now the most recently used
    cache.validate(version('v3'), {}); // evicts v2
    expect(cache.size).toBe(2);
    expect(build).toHaveBeenCalledTimes(3);
    cache.validate(version('v1'), {});
    expect(build).toHaveBeenCalledTimes(3);
    cache.validate(version('v2'), {});
    expect(build).toHaveBeenCalledTimes(4);
  });

  it('defaults to the contracts validator and a bound of MATCHER_CACHE_SIZE', () => {
    const cache = new MatcherCache();
    expect(cache.validate(version('v1'), { code: 'ABC' })).toEqual({ ok: true, data: { code: 'ABC' } });
    expect(cache.validate(version('v1'), { code: 'abc' })).toEqual({ ok: false, errors: { code: ['Does not match the expected format'] } });
    expect(MATCHER_CACHE_SIZE).toBeGreaterThan(0);
    expect(() => new MatcherCache(0)).toThrow(/capacity/);
  });
});
