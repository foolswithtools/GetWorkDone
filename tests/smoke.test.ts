import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.ts';

// The suite's first green test: the package entry loads.
describe('package entry', () => {
  it('loads and names the package', () => {
    expect(entry.name).toBe('getworkdone');
  });
});
