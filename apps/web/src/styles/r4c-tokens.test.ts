import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// GWP#10: the request-4-change widget's six tokens (widget contract v1, "Styling") take the base theme's
// values (GWP#47, base.css), so the widget follows the theme and its dark scheme with no colour of its own.
const css = readFileSync(new URL('./r4c-tokens.css', import.meta.url), 'utf8');
const base = readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const MAP = { 'font-family': 'font-family', 'color-fg': 'color-fg', 'color-bg': 'color-bg', 'color-accent': 'color-accent', radius: 'radius', spacing: 'spacing' };

describe('r4c-tokens.css', () => {
  const body = /r4c-widget\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const declared = new Map([...body.matchAll(/--r4c-([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name as string, (value as string).trim()]));

  it('sets exactly the six widget tokens on r4c-widget, each from its --gwd-* theme token', () => {
    expect(Object.fromEntries(declared)).toEqual(Object.fromEntries(Object.entries(MAP).map(([r4c, gwd]) => [r4c, `var(--gwd-${gwd})`])));
  });

  it('every theme token it reads is declared in base.css', () => {
    for (const gwd of Object.values(MAP)) expect(base, `--gwd-${gwd}`).toMatch(new RegExp(`--gwd-${gwd}\\s*:`));
  });

  it('holds no colour value of its own', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
