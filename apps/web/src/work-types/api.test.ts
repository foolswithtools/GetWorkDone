import { describe, expect, it, vi } from 'vitest';
import { addVersion, archiveWorkType, createExport, createWorkType, exportDownloadPath, getWorkType, listExports, listItems, listWorkTypes, submitItem } from './api.js';

const definition = { fields: [{ key: 'title', label: 'Title', type: 'text' as const, required: true }], steps: [], outputs: [{ id: 'keep', kind: 'persist' as const, config: {} }] };

function call(fetchImpl: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}
const json = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('work type API calls', () => {
  it('reads work types and items with a traceparent, and throws on an error status', async () => {
    const fetchImpl = json(200, [{ id: 'wt' }]);
    expect(await listWorkTypes('t1', fetchImpl)).toEqual([{ id: 'wt' }]);
    // GWP#55: archived work types too; the team page shows them apart.
    expect(call(fetchImpl).url).toBe('/api/v1/teams/t1/work-types?includeArchived=true');
    expect(call(fetchImpl).headers.get('traceparent')).toMatch(/^00-/);
    const items = json(200, { items: [{ id: 'i' }], nextCursor: 'c1' });
    expect(await listItems('t1', 'wt', {}, items)).toEqual({ items: [{ id: 'i' }], nextCursor: 'c1' });
    expect(call(items).url).toBe('/api/v1/teams/t1/work-types/wt/items');
    await expect(listItems('t1', 'wt', {}, json(403, {}))).rejects.toThrow('GET /api/v1/teams/t1/work-types/wt/items answered 403');
  });

  it('archives and unarchives a work type with an empty body and the CSRF header (GWP#55)', async () => {
    const archive = json(200, { id: 'wt', archivedAt: '2026-10-31T12:00:00.000Z' });
    expect(await archiveWorkType('t1', 'w t', true, 'tok', archive)).toEqual({ ok: true, value: { id: 'wt', archivedAt: '2026-10-31T12:00:00.000Z' } });
    expect([call(archive).url, call(archive).init.method, call(archive).init.body, call(archive).headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams/t1/work-types/w%20t/archive', 'POST', '{}', 'tok']);
    const unarchive = json(403, { message: 'This needs the team admin role' });
    expect(await archiveWorkType('t1', 'wt', false, 'tok', unarchive)).toEqual({ ok: false, errors: { _form: ['This needs the team admin role'] } });
    expect(call(unarchive).url).toBe('/api/v1/teams/t1/work-types/wt/unarchive');
  });

  it('asks for the next page of items with the cursor the last page gave', async () => {
    const items = json(200, { items: [], nextCursor: null });
    await listItems('t1', 'wt', { cursor: 'a+b/=' }, items);
    expect(call(items).url).toBe('/api/v1/teams/t1/work-types/wt/items?cursor=a%2Bb%2F%3D');
  });

  it('asks for one status only, beside the cursor (GWP#54)', async () => {
    const items = json(200, { items: [], nextCursor: null });
    await listItems('t1', 'wt', { status: 'failed' }, items);
    await listItems('t1', 'wt', { status: 'failed', cursor: 'c1' }, items);
    expect([call(items, 0).url, call(items, 1).url]).toEqual(['/api/v1/teams/t1/work-types/wt/items?status=failed', '/api/v1/teams/t1/work-types/wt/items?cursor=c1&status=failed']);
  });

  it('reads one work type afresh from the team\'s list; one that is gone is an error', async () => {
    expect(await getWorkType('t1', 'wt2', json(200, [{ id: 'wt1' }, { id: 'wt2', version: { version: 3 } }]))).toEqual({ id: 'wt2', version: { version: 3 } });
    await expect(getWorkType('t1', 'gone', json(200, [{ id: 'wt1' }]))).rejects.toThrow('Work type gone not found');
  });

  it('submits an item as { data } with the CSRF header; 201 is the item', async () => {
    const fetchImpl = json(201, { id: 'i1' });
    expect(await submitItem('t1', 'wt', { title: 'x' }, 'tok', fetchImpl)).toEqual({ ok: true, value: { id: 'i1' } });
    const { url, init, headers } = call(fetchImpl);
    expect([url, init.method, init.body]).toEqual(['/api/v1/teams/t1/work-types/wt/items', 'POST', '{"data":{"title":"x"}}']);
    expect(headers.get('x-gwd-csrf')).toBe('tok');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('a 422 is the server\'s keyed errors; a 400 with issues is keyed by path; anything else is a form error', async () => {
    expect(await submitItem('t1', 'wt', {}, 'tok', json(422, { errors: { title: ['Required'] } }))).toEqual({ ok: false, errors: { title: ['Required'] } });
    expect(await createWorkType('t1', 'x', definition, 'tok', json(400, { message: 'Invalid request body', issues: [{ path: 'definition.fields.0.pattern', message: 'bad' }, { path: 'definition.fields.0.pattern', message: 'worse' }] })))
      .toEqual({ ok: false, errors: { 'definition.fields.0.pattern': ['bad', 'worse'] } });
    expect(await createWorkType('t1', 'x', definition, 'tok', json(409, { message: 'Work type "x" already exists in this team' }))).toEqual({ ok: false, errors: { _form: ['Work type "x" already exists in this team'] } });
    expect(await addVersion('t1', 'wt', definition, 'tok', vi.fn(async () => new Response('not json', { status: 500 })))).toEqual({ ok: false, errors: { _form: ['The server answered 500'] } });
  });

  it('creates a work type from a slug and a definition, and adds a version from a definition', async () => {
    const create = json(201, { id: 'wt' });
    expect(await createWorkType('t1', 'orders', definition, 'tok', create)).toEqual({ ok: true, value: { id: 'wt' } });
    expect([call(create).url, call(create).init.body]).toEqual(['/api/v1/teams/t1/work-types', JSON.stringify({ slug: 'orders', definition })]);
    const version = json(201, { id: 'wt' });
    await addVersion('t1', 'wt', definition, 'tok', version);
    expect([call(version).url, call(version).init.body]).toEqual(['/api/v1/teams/t1/work-types/wt/versions', JSON.stringify({ definition })]);
  });

  it('generates and lists a work type\'s exports, and names the download path', async () => {
    const create = json(201, { id: 'e1' });
    expect(await createExport('t1', 'wt', 'json', 'tok', create)).toEqual({ ok: true, value: { id: 'e1' } });
    expect([call(create).url, call(create).init.method, call(create).init.body]).toEqual(['/api/v1/teams/t1/work-types/wt/exports', 'POST', '{"format":"json"}']);
    expect(call(create).headers.get('x-gwd-csrf')).toBe('tok');
    const list = json(200, [{ id: 'e1' }]);
    expect(await listExports('t1', 'wt', list)).toEqual([{ id: 'e1' }]);
    expect(call(list).url).toBe('/api/v1/teams/t1/work-types/wt/exports');
    expect(exportDownloadPath('t 1', 'e1')).toBe('/api/v1/teams/t%201/exports/e1/download');
  });

  // GWP#35: within 30 seconds of the last export the route answers 429 with Retry-After in seconds.
  it('a 429 from the export route carries its Retry-After seconds; without a usable header it carries none', async () => {
    const message = 'This work type was exported less than 30 seconds ago; try again shortly';
    const tooSoon = (headers: Record<string, string>) => vi.fn(async () => new Response(JSON.stringify({ message }), { status: 429, headers }));
    expect(await createExport('t1', 'wt', 'csv', 'tok', tooSoon({ 'Retry-After': '20' }))).toEqual({ ok: false, errors: { _form: [message] }, retryAfterSeconds: 20 });
    expect(await createExport('t1', 'wt', 'csv', 'tok', tooSoon({}))).not.toHaveProperty('retryAfterSeconds');
    expect(await createExport('t1', 'wt', 'csv', 'tok', tooSoon({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).not.toHaveProperty('retryAfterSeconds');
    expect(await createExport('t1', 'wt', 'csv', 'tok', tooSoon({ 'Retry-After': '0' }))).not.toHaveProperty('retryAfterSeconds');
  });
});
