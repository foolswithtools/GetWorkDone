// Express hands routes `req.path` as the client sent it: not percent-decoded, `\` left alone, `.` and
// `..` segments unresolved and a leading run of slashes intact. So `//api/v1/me`, `/%2Fapi/v1/me`,
// `/x/../api/v1/me` and `/\api/v1/me` all reach the SPA catch-all. The path checks (isProtectedPath,
// isReservedPath) match through matchesPath instead, so none of these spellings takes a path out of
// /api or /__r4c (GWP#15, GWP#30).

import { posix } from 'node:path';

/** The path with any run of leading slashes collapsed to one. */
export function collapseLeadingSlashes(path: string): string {
  return path.replace(/^\/{2,}/, '/');
}

/** The path decoded, with `\` read as `/`, dot segments resolved and repeated slashes collapsed; undefined for a malformed escape. */
export function resolvedPath(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return posix.normalize(decoded.replace(/\\/g, '/'));
}

/**
 * True when `pattern` matches the path as sent (leading slashes collapsed) or its resolved form. It
 * only ever widens a match: a real route under /api/v1 whose resolved form leaves it (a `..` or `%2F`
 * in a parameter) stays matched. A malformed escape fails closed and matches.
 */
export function matchesPath(pattern: RegExp, path: string): boolean {
  if (pattern.test(collapseLeadingSlashes(path))) return true;
  const resolved = resolvedPath(path);
  return resolved === undefined || pattern.test(resolved);
}
