import { describe, expect, it, vi } from 'vitest';
import { cancelItem, completeStep, editItemData, getDeliveries, getItem, listWaitingItems, resumeItem, retryStep } from './api.js';

function call(fetchImpl: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}
const json = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('item API calls', () => {
  it('reads the waiting-for-me queue, and its next page with the cursor the last page gave (GWP#55)', async () => {
    const first = json(200, { items: [{ id: 'i1' }], nextCursor: 'c 1' });
    expect(await listWaitingItems('t1', {}, first)).toEqual({ items: [{ id: 'i1' }], nextCursor: 'c 1' });
    expect(call(first).url).toBe('/api/v1/teams/t1/items?waiting=me');
    const next = json(200, { items: [], nextCursor: null });
    await listWaitingItems('t1', { cursor: 'c 1' }, next);
    expect(call(next).url).toBe('/api/v1/teams/t1/items?waiting=me&cursor=c+1');
    await expect(listWaitingItems('t1', {}, json(403, {}))).rejects.toThrow('answered 403');
  });

  it('reads one item with its steps', async () => {
    const fetchImpl = json(200, { id: 'i1', steps: [] });
    expect(await getItem('t1', 'i1', fetchImpl)).toEqual({ id: 'i1', steps: [] });
    expect(call(fetchImpl).url).toBe('/api/v1/teams/t1/items/i1');
  });

  it('completes and retries a step with the rowVersion it read and the CSRF header', async () => {
    const complete = json(200, { id: 'i1', status: 'completed' });
    expect(await completeStep('t1', 'i1', 'review step', { rowVersion: 4 }, 'tok', complete)).toEqual({ ok: true, value: { id: 'i1', status: 'completed' } });
    expect([call(complete).url, call(complete).init.method, call(complete).init.body]).toEqual(['/api/v1/teams/t1/items/i1/steps/review%20step/complete', 'POST', '{"rowVersion":4}']);
    expect(call(complete).headers.get('x-gwd-csrf')).toBe('tok');
    const retry = json(409, { message: 'This step has not failed' });
    expect(await retryStep('t1', 'i1', 'up', 2, 'tok', retry)).toEqual({ ok: false, errors: { _form: ['This step has not failed'] } });
    expect(call(retry).url).toBe('/api/v1/teams/t1/items/i1/steps/up/retry');
  });

  it('resumes a stopped item with the rowVersion it read and the CSRF header (GWP#22)', async () => {
    const resume = json(200, { id: 'i 1', status: 'in_progress' });
    expect(await resumeItem('t1', 'i 1', 0, 'tok', resume)).toEqual({ ok: true, value: { id: 'i 1', status: 'in_progress' } });
    expect([call(resume).url, call(resume).init.method, call(resume).init.body, call(resume).headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams/t1/items/i%201/advance', 'POST', '{"rowVersion":0}', 'tok']);
    const waiting = json(409, { message: 'This item is waiting at step "Review" for a member to complete it' });
    expect(await resumeItem('t1', 'i1', 3, 'tok', waiting)).toEqual({ ok: false, errors: { _form: ['This item is waiting at step "Review" for a member to complete it'] } });
  });

  it('completes a step with a decision and a comment, and cancels an item with a reason (GWP#54)', async () => {
    const complete = json(200, { id: 'i1', status: 'completed' });
    await completeStep('t1', 'i1', 'approve', { rowVersion: 4, decision: 'approve', comment: 'ok' }, 'tok', complete);
    expect(call(complete).init.body).toBe('{"rowVersion":4,"decision":"approve","comment":"ok"}');
    const cancel = json(200, { id: 'i 1', status: 'cancelled' });
    expect(await cancelItem('t1', 'i 1', 3, 'captured twice', 'tok', cancel)).toEqual({ ok: true, value: { id: 'i 1', status: 'cancelled' } });
    expect([call(cancel).url, call(cancel).init.method, call(cancel).init.body, call(cancel).headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams/t1/items/i%201/cancel', 'POST', '{"rowVersion":3,"reason":"captured twice"}', 'tok']);
    const bare = json(409, { message: 'This item is already completed' });
    expect(await cancelItem('t1', 'i1', 3, undefined, 'tok', bare)).toEqual({ ok: false, errors: { _form: ['This item is already completed'] } });
    expect(call(bare).init.body).toBe('{"rowVersion":3}');
  });

  it('replaces an item\'s data with the rowVersion it read and the CSRF header; a 422 keeps its errors (GWP#23)', async () => {
    const edit = json(200, { id: 'i 1', status: 'failed' });
    expect(await editItemData('t1', 'i 1', 2, { title: 'Desk', qty: 3 }, 'tok', edit)).toEqual({ ok: true, value: { id: 'i 1', status: 'failed' } });
    expect([call(edit).url, call(edit).init.method, call(edit).init.body, call(edit).headers.get('x-gwd-csrf')]).toEqual(['/api/v1/teams/t1/items/i%201/data', 'POST', '{"rowVersion":2,"data":{"title":"Desk","qty":3}}', 'tok']);
    const invalid = json(422, { errors: { qty: ['Must be at least 1'] } });
    expect(await editItemData('t1', 'i1', 2, { qty: 0 }, 'tok', invalid)).toEqual({ ok: false, errors: { qty: ['Must be at least 1'] } });
  });

  it('reads an item\'s deliveries', async () => {
    const fetchImpl = json(200, [{ id: 'd1', status: 'delivered' }]);
    expect(await getDeliveries('t1', 'i 1', fetchImpl)).toEqual([{ id: 'd1', status: 'delivered' }]);
    expect(call(fetchImpl).url).toBe('/api/v1/teams/t1/items/i%201/deliveries');
  });
});
