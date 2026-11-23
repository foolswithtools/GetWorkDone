import { describe, expect, it, vi } from 'vitest';
import { addMember, createTeam, listMembers, removeMember } from './api.js';

function call(fetchImpl: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}
const json = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('team member API calls (GWP#20)', () => {
  it('lists a team\'s members, and throws on an error status', async () => {
    const alice = { subject: 'alice', role: 'admin', createdAt: 'x', email: 'alice@example.test', displayName: 'Alice' };
    const fetchImpl = json(200, [alice]);
    expect(await listMembers('t 1', fetchImpl)).toEqual([alice]);
    expect(call(fetchImpl).url).toBe('/api/v1/teams/t%201/members');
    await expect(listMembers('t1', json(403, {}))).rejects.toThrow('GET /api/v1/teams/t1/members answered 403');
  });

  it('adds a member as { subject, role } with the CSRF header; a 409 is a form error', async () => {
    const fetchImpl = json(201, { subject: 'bob', role: 'member', createdAt: 'x', email: null, displayName: null });
    expect(await addMember('t1', { subject: 'bob', role: 'member' }, 'tok', fetchImpl)).toEqual({ ok: true, value: { subject: 'bob', role: 'member', createdAt: 'x', email: null, displayName: null } });
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, init.body, headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams/t1/members', 'POST', '{"subject":"bob","role":"member"}', 'tok']);
    expect(await addMember('t1', { subject: 'bob', role: 'member' }, 'tok', json(409, { message: 'bob is already a member of this team' })))
      .toEqual({ ok: false, errors: { _form: ['bob is already a member of this team'] } });
  });

  it('removes a member by its encoded subject with DELETE and the CSRF header; 204 is ok, 409 a form error', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await removeMember('t1', 'auth0|a/b', 'tok', fetchImpl)).toEqual({ ok: true, value: undefined });
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, init.body, headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams/t1/members/auth0%7Ca%2Fb', 'DELETE', undefined, 'tok']);
    expect(await removeMember('t1', 'alice', 'tok', json(409, { message: 'A team needs an admin' }))).toEqual({ ok: false, errors: { _form: ['A team needs an admin'] } });
  });

  it('creates a team as { name } with the CSRF header (GWP#49); a 400 is keyed by path, a 403 a form error', async () => {
    const fetchImpl = json(201, { id: 't1', name: 'Ops', createdAt: 'x' });
    expect(await createTeam('Ops', 'tok', fetchImpl)).toEqual({ ok: true, value: { id: 't1', name: 'Ops', createdAt: 'x' } });
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, init.body, headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams', 'POST', '{"name":"Ops"}', 'tok']);
    expect(await createTeam('x'.repeat(121), 'tok', json(400, { message: 'Invalid request body', issues: [{ path: 'name', message: 'Too big' }] })))
      .toEqual({ ok: false, errors: { name: ['Too big'] } });
    expect(await createTeam('Ops', '', json(403, { message: 'Missing or invalid CSRF token', statusCode: 403 })))
      .toEqual({ ok: false, errors: { _form: ['Missing or invalid CSRF token'] } });
  });
});
