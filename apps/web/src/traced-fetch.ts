// The SPA's fetch wrapper: every API call carries a W3C `traceparent`, so the API's request span joins
// the browser's trace (spec §3.5 variant 5b; prebutton.md:353). The exemplar's storefront never
// forwarded one, so browser and backend traces never shared a trace id (exemplar analysis finding 4).

type Random = <T extends ArrayBufferView>(bytes: T) => T;

const defaultRandom: Random = (bytes) => crypto.getRandomValues(bytes as unknown as Uint8Array) as unknown as typeof bytes;

/** `length` random bytes as lowercase hex, never all zeros (an invalid W3C id). */
function randomHex(length: number, random: Random): string {
  for (;;) {
    const bytes = random(new Uint8Array(length));
    if (bytes.some((b) => b !== 0)) return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

/** A new sampled `traceparent`: version 00, a fresh trace id and span id, flags 01. */
export function newTraceparent(random: Random = defaultRandom): string {
  return `00-${randomHex(16, random)}-${randomHex(8, random)}-01`;
}

/** fetch with a new `traceparent` header on each call. */
export function tracedFetch(input: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('traceparent', newTraceparent());
  return fetchImpl(input, { ...init, headers });
}
