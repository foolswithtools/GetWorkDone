import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for white on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });

  it('puts #767676 on white just over the AA boundary of 4.5', () => {
    const ratio = contrastRatio('#767676', '#FFFFFF');
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(4.6);
  });

  it('does not depend on argument order', () => {
    expect(contrastRatio('#b00020', '#ffffff')).toBe(contrastRatio('#ffffff', '#b00020'));
  });

  it('throws on a malformed hex colour', () => {
    for (const bad of ['#fff', 'ffffff', '#gggggg', '#1234567', '', 'red']) {
      expect(() => contrastRatio(bad, '#ffffff'), bad).toThrow(/hex colour/);
      expect(() => contrastRatio('#ffffff', bad), bad).toThrow(/hex colour/);
    }
  });
});
