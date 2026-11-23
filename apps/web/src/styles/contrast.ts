// WCAG 2.2 contrast ratio (GWP#47): tokens.test.ts checks the theme tokens in base.css with it. Pure, no DOM.
// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio and #dfn-relative-luminance.

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function luminance(hex: string): number {
  const match = HEX.exec(hex);
  if (!match) throw new Error(`not a #rrggbb hex colour: ${JSON.stringify(hex)}`);
  const [r, g, b] = match.slice(1).map((pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two `#rrggbb` colours, from 1 to 21; the order of the arguments does not matter. */
export function contrastRatio(hexA: string, hexB: string): number {
  const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}
