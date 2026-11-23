import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';

// GWP#47: the theme tokens in base.css meet WCAG 2.2 AA (4.5:1) in both colour schemes. The values are
// read from the stylesheet itself, so a token change that breaks a pair fails here.
const css = readFileSync(new URL('./base.css', import.meta.url), 'utf8');

const TOKENS = ['font-family', 'color-fg', 'color-bg', 'color-accent', 'color-error', 'color-border', 'radius', 'spacing'];
const COLOURS = ['fg', 'bg', 'accent', 'error', 'border'];
// The accent is a button background with bg text: the same pair as accent on bg.
const PAIRS = [['fg', 'bg'], ['error', 'bg'], ['accent', 'bg']] as const;

/** The body of the first `selector { ... }` block in `text`, matched by brace depth. */
function block(selector: string, text = css): string {
  const start = text.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in base.css`);
  let depth = 0;
  const open = text.indexOf('{', start);
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selector} block in base.css`);
}

function declarations(body: string): Map<string, string> {
  return new Map([...body.matchAll(/--gwd-([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name as string, (value as string).trim()]));
}

const dark = block('@media (prefers-color-scheme: dark)');
// The dark block redeclares the colours on its own `:root`; drop it so the light values come from the top level.
const light = declarations(block(':root', css.replace(dark, '')));
const darkTokens = declarations(dark);

describe('base.css theme tokens', () => {
  it('declares every token on :root, and every colour token again in the dark block', () => {
    for (const token of TOKENS) expect(light.get(token), `--gwd-${token} on :root`).toBeTruthy();
    for (const colour of COLOURS) expect(darkTokens.get(`color-${colour}`), `--gwd-color-${colour} in the dark block`).toBeTruthy();
  });

  for (const [scheme, tokens] of [['light', light], ['dark', darkTokens]] as const) {
    for (const [a, b] of PAIRS) {
      it(`${a} on ${b} is at least 4.5:1 in the ${scheme} scheme`, () => {
        expect(contrastRatio(tokens.get(`color-${a}`) ?? '', tokens.get(`color-${b}`) ?? '')).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
