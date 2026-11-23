// The SPA's side of sign-in (GWP#3, docs/auth.md). The session cookie is HttpOnly, so the SPA never
// sees it: it asks GET /api/v1/me who is signed in, and sends the CSRF token from that answer as the
// X-GWD-CSRF header on every state-changing request. Sign-in is a full-page visit to /auth/login.

import type { MeResponse } from '@getworkdone/contracts';
import { tracedFetch } from '../traced-fetch.js';

export const SIGN_IN_URL = '/auth/login';
export const CSRF_HEADER = 'X-GWD-CSRF';

export type MeState = { status: 'signed-in'; me: MeResponse } | { status: 'signed-out' };

/** Who is signed in: 401 means nobody; any other failure is an error. */
export async function fetchMe(fetchImpl: typeof fetch = fetch): Promise<MeState> {
  const res = await tracedFetch('/api/v1/me', { credentials: 'same-origin', headers: { accept: 'application/json' } }, fetchImpl);
  if (res.status === 401) return { status: 'signed-out' };
  if (!res.ok) throw new Error(`/api/v1/me answered ${res.status}`);
  return { status: 'signed-in', me: await res.json() as MeResponse };
}

/** A state-changing API call with the CSRF header; the parsed JSON answer, or undefined for 204. */
export async function apiWrite<T = unknown>(path: string, body: unknown, csrfToken: string, { method = 'POST', fetchImpl = fetch }: { method?: string; fetchImpl?: typeof fetch } = {}): Promise<T | undefined> {
  const headers: Record<string, string> = { accept: 'application/json', [CSRF_HEADER]: csrfToken };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await tracedFetch(path, { method, credentials: 'same-origin', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, fetchImpl);
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.status === 204 ? undefined : await res.json() as T;
}

/** Ends the session on the server; the caller reloads to show the signed-out page. */
export async function signOut(csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await apiWrite('/auth/logout', undefined, csrfToken, { fetchImpl });
}

/** Ends every session of the signed-in person, on every device (GWP#56); the caller reloads as for signOut. */
export async function signOutEverywhere(csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await apiWrite('/auth/logout/all', undefined, csrfToken, { fetchImpl });
}
