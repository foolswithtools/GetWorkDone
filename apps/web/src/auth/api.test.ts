import { describe, expect, it, vi } from 'vitest';
import { apiWrite, fetchMe, SIGN_IN_URL, signOut, signOutEverywhere } from './api.js';

const ME = { subject: 's', email: 'e@example.test', csrfToken: 'tok', teams: [{ id: 't', name: 'Team', role: 'admin' }] };

function call(fetchImpl: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

describe('fetchMe', () => {
  it('is signed in with the identity on 200, with a traceparent on the request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ME), { status: 200 }));
    expect(await fetchMe(fetchImpl)).toEqual({ status: 'signed-in', me: ME });
    const { url, init, headers } = call(fetchImpl);
    expect(url).toBe('/api/v1/me');
    expect(init.credentials).toBe('same-origin');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('traceparent')).toMatch(/^00-/);
  });

  it('is signed out on 401, and throws on any other status', async () => {
    expect(await fetchMe(vi.fn(async () => new Response('', { status: 401 })))).toEqual({ status: 'signed-out' });
    await expect(fetchMe(vi.fn(async () => new Response('', { status: 500 })))).rejects.toThrow('/api/v1/me answered 500');
  });
});

describe('apiWrite', () => {
  it('sends the X-GWD-CSRF header and a JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"t2"}', { status: 201 }));
    expect(await apiWrite('/api/v1/teams', { name: 'Ops' }, 'tok', { fetchImpl })).toEqual({ id: 't2' });
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, init.body]).toEqual(['/api/v1/teams', 'POST', '{"name":"Ops"}']);
    expect(headers.get('x-gwd-csrf')).toBe('tok');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('takes another method, sends no body when there is none, returns undefined on 204 and throws on an error status', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await apiWrite('/x', undefined, 'tok', { method: 'DELETE', fetchImpl })).toBeUndefined();
    expect(call(fetchImpl).init.body).toBeUndefined();
    expect(call(fetchImpl).headers.has('content-type')).toBe(false);
    await expect(apiWrite('/x', {}, 'tok', { fetchImpl: vi.fn(async () => new Response('', { status: 403 })) })).rejects.toThrow('POST /x answered 403');
  });
});

describe('signOut', () => {
  it('POSTs /auth/logout with the CSRF header', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await signOut('tok', fetchImpl);
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, headers.get('x-gwd-csrf')]).toEqual(['/auth/logout', 'POST', 'tok']);
  });

  it('signOutEverywhere POSTs /auth/logout/all with the CSRF header, and throws when refused (GWP#56)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await signOutEverywhere('tok', fetchImpl);
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, headers.get('x-gwd-csrf')]).toEqual(['/auth/logout/all', 'POST', 'tok']);
    await expect(signOutEverywhere('tok', vi.fn(async () => new Response('', { status: 403 })))).rejects.toThrow('POST /auth/logout/all answered 403');
  });

  it('signs in at /auth/login', () => {
    expect(SIGN_IN_URL).toBe('/auth/login');
  });
});
