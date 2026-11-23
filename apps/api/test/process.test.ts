import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { DistributionOutput, ProcessStep } from '@getworkdone/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/modules/database/database.js';
import type { DeliveryWorker } from '../src/modules/distribute/delivery.worker.js';
import type { ItemsService } from '../src/modules/items/items.service.js';
import { nextAction } from '../src/modules/process/engine.js';
import { changedFields, ProcessService } from '../src/modules/process/process.service.js';

// Unit partition (GWP#5, docs/process.md): what the engine does next from an item's status, current
// step index and last event. The transitions themselves run against Postgres in process.integration.test.ts.
const steps: ProcessStep[] = [
  { id: 'auto', name: 'Auto', kind: 'automated', transform: 'set_field', params: { field: 'a', value: 1 } },
  { id: 'human', name: 'Human', kind: 'human', assigneeRole: 'member' },
];

describe('nextAction', () => {
  it('a new item starts its first step, or completes when there are none', () => {
    expect(nextAction(steps, { status: 'open', currentStepIndex: 0 }, 'captured')).toEqual({ kind: 'start', index: 0 });
    expect(nextAction([], { status: 'open', currentStepIndex: 0 }, 'captured')).toEqual({ kind: 'complete' });
  });

  it('a started automated step runs; a started human step waits', () => {
    expect(nextAction(steps, { status: 'in_progress', currentStepIndex: 0 }, 'step_started')).toEqual({ kind: 'run', index: 0 });
    expect(nextAction(steps, { status: 'in_progress', currentStepIndex: 1 }, 'step_started')).toEqual({ kind: 'wait', index: 1 });
  });

  it('after a completed step the next one starts, and after the last the item completes', () => {
    expect(nextAction(steps, { status: 'in_progress', currentStepIndex: 1 }, 'step_completed')).toEqual({ kind: 'start', index: 1 });
    expect(nextAction(steps, { status: 'in_progress', currentStepIndex: 2 }, 'step_completed')).toEqual({ kind: 'complete' });
  });

  it('completed, failed and cancelled items stop', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) expect(nextAction(steps, { status, currentStepIndex: 0 }, 'step_failed')).toEqual({ kind: 'stop' });
  });

  it('a started step the definition does not have stops rather than guessing', () => {
    expect(nextAction(steps, { status: 'in_progress', currentStepIndex: 5 }, 'step_started')).toEqual({ kind: 'stop' });
  });
});

// The service against a stand-in Prisma client: how each refusal maps to an HTTP error, and that a lost
// race writes no event. The real transactions are in process.integration.test.ts.
const definition = {
  fields: [
    { key: 'a', label: 'A', type: 'number' as const, required: false },
    { key: 'b', label: 'B', type: 'text' as const, required: false },
    { key: 'c', label: 'C', type: 'text' as const, required: false },
  ],
  steps: [...steps, { id: 'boss', name: 'Boss', kind: 'human' as const, assigneeRole: 'admin' as const }],
  outputs: [{ id: 'keep', kind: 'persist' as const, config: {} }],
};

function fakeProcess(row: Partial<{ status: string; currentStepIndex: number; rowVersion: number; last: string; steps: ProcessStep[]; outputs: DistributionOutput[]; data: Record<string, unknown>; waitingRole: 'member' | 'admin' | null }> = {}) {
  const item = { id: 'i1', teamId: 'team-a', data: row.data ?? {}, status: row.status ?? 'in_progress', currentStepIndex: row.currentStepIndex ?? 1, rowVersion: row.rowVersion ?? 3, waitingRole: row.waitingRole ?? null };
  const tx = {
    item: { updateMany: vi.fn(async () => ({ count: 1 })) },
    itemEvent: { aggregate: vi.fn(async () => ({ _max: { seq: 4 } })), create: vi.fn(async () => ({})) },
    delivery: { createMany: vi.fn(async () => ({ count: 0 })) },
  };
  const client = {
    item: { updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async (): Promise<object | null> => ({ ...item, workTypeVersion: { definition: { ...definition, steps: row.steps ?? definition.steps, outputs: row.outputs ?? definition.outputs } }, events: [{ type: row.last ?? 'step_started' }] })) },
    teamMember: { findUnique: vi.fn(async (): Promise<object | null> => ({ role: 'member' })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const items = { get: vi.fn(async () => ({ id: 'i1', status: 'completed' })) };
  const worker = { kick: vi.fn() };
  const service = new ProcessService({ client } as unknown as Database, items as unknown as ItemsService, worker as unknown as DeliveryWorker);
  return { service, client, tx, items, worker };
}

describe('ProcessService', () => {
  it('an item or step that is not there is 404', async () => {
    const { service, client } = fakeProcess();
    await expect(service.completeStep('team-a', 'i1', 'nope', 3, 'alice')).rejects.toBeInstanceOf(NotFoundException);
    client.item.findFirst.mockResolvedValueOnce(null);
    await expect(service.completeStep('team-b', 'i1', 'human', 3, 'alice')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.item.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'i1', teamId: 'team-b' } }));
  });

  it('a member completing an admin step is 403; a stale rowVersion or a step that is not waiting is 409', async () => {
    const { service, tx } = fakeProcess({ currentStepIndex: 2 });
    await expect(service.completeStep('team-a', 'i1', 'boss', 3, 'alice')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.completeStep('team-a', 'i1', 'human', 3, 'alice')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.completeStep('team-a', 'i1', 'auto', 3, 'alice')).rejects.toBeInstanceOf(ConflictException);
    const stale = fakeProcess();
    await expect(stale.service.completeStep('team-a', 'i1', 'human', 2, 'alice')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.item.updateMany).not.toHaveBeenCalled();
  });

  it('a completion that loses the race to the guarded UPDATE is 409 and writes no event', async () => {
    const { service, tx } = fakeProcess();
    tx.item.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.completeStep('team-a', 'i1', 'human', 3, 'alice')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.item.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'i1', teamId: 'team-a', rowVersion: 3 } }));
    expect(tx.itemEvent.create).not.toHaveBeenCalled();
  });

  it('a retry of an item that has not failed, or of another step, is 409', async () => {
    const { service } = fakeProcess({ status: 'failed', currentStepIndex: 0, last: 'step_failed' });
    await expect(service.retry('team-a', 'i1', 'human', 3, 'admin')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.retry('team-a', 'i1', 'auto', 2, 'admin')).rejects.toBeInstanceOf(ConflictException);
    const running = fakeProcess();
    await expect(running.service.retry('team-a', 'i1', 'human', 3, 'admin')).rejects.toBeInstanceOf(ConflictException);
  });

  it('advance on an item waiting at a human step writes nothing', async () => {
    const { service, tx, items, client } = fakeProcess({ waitingRole: 'member' });
    await service.advance('team-a', 'i1', 3, 'alice');
    expect(tx.item.updateMany).not.toHaveBeenCalled();
    expect(client.item.updateMany).not.toHaveBeenCalled();
    expect(items.get).toHaveBeenCalledWith('team-a', 'i1');
  });

  // GWP#55: a waiting item without its waitingRole (a step started before the column) gets it, with no transition.
  it('advance on a waiting item whose waitingRole is missing sets it in place, matched on rowVersion', async () => {
    const { service, tx, client } = fakeProcess();
    await service.advance('team-a', 'i1', 3, null);
    expect(tx.item.updateMany).not.toHaveBeenCalled();
    expect(client.item.updateMany).toHaveBeenCalledWith({ where: { id: 'i1', teamId: 'team-a', rowVersion: 3 }, data: { waitingRole: 'member' } });
  });

  // GWP#22: resume refuses, before any write, an item that is not stuck between transitions.
  it('resume of an item waiting at a human step, failed or completed is 409 saying which, and writes nothing', async () => {
    const waiting = fakeProcess();
    await expect(waiting.service.resume('team-a', 'i1', 3, 'admin')).rejects.toThrow('This item is waiting at step "Human" for a member to complete it');
    await expect(fakeProcess({ currentStepIndex: 2 }).service.resume('team-a', 'i1', 3, 'admin')).rejects.toThrow('This item is waiting at step "Boss" for an admin to complete it');
    const failed = fakeProcess({ status: 'failed', currentStepIndex: 0, last: 'step_failed' });
    await expect(failed.service.resume('team-a', 'i1', 3, 'admin')).rejects.toThrow('This item failed at step "Auto"; retry that step instead');
    const completed = fakeProcess({ status: 'completed', currentStepIndex: 3, last: 'completed' });
    await expect(completed.service.resume('team-a', 'i1', 3, 'admin')).rejects.toThrow('This item is already completed');
    await expect(waiting.service.resume('team-a', 'i1', 2, 'admin')).rejects.toThrow(/changed since it was read/);
    for (const { tx } of [waiting, failed, completed]) expect(tx.item.updateMany).not.toHaveBeenCalled();
  });

  it('resume of an item stopped between transitions advances it from where it stands', async () => {
    const { service, tx, client } = fakeProcess();
    // resume reads the item once, then advance reads it before each transition.
    const open = { id: 'i1', teamId: 'team-a', data: {}, status: 'open', currentStepIndex: 0, rowVersion: 0, workTypeVersion: { definition }, events: [{ type: 'captured' }] };
    const started = { ...open, status: 'in_progress', rowVersion: 1, events: [{ type: 'step_started' }] };
    const done = { ...started, data: { a: 1 }, currentStepIndex: 1, rowVersion: 2, events: [{ type: 'step_completed' }] };
    const waiting = { ...done, rowVersion: 3, events: [{ type: 'step_started' }] };
    for (const read of [open, open, started, done, waiting]) client.item.findFirst.mockResolvedValueOnce(read);
    await service.resume('team-a', 'i1', 0, 'admin');
    const written = tx.itemEvent.create.mock.calls.map((call) => (call as unknown as [{ data: { type: string; actorSubject: string | null } }])[0].data);
    expect(written.map((e) => [e.type, e.actorSubject])).toEqual([
      ['step_started', null], ['step_completed', null], ['step_started', 'admin'],
    ]);
  });

  it('a failing onItemCompleted hook is logged, not thrown: the item is completed either way', async () => {
    const { service, tx } = fakeProcess({ status: 'open', currentStepIndex: 0, rowVersion: 0, last: 'captured', steps: [] });
    vi.spyOn(service, 'onItemCompleted').mockRejectedValueOnce(new Error('hook down'));
    await expect(service.advance('team-a', 'i1', 0, 'alice')).resolves.toMatchObject({ status: 'completed' });
    expect(tx.itemEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ seq: 5, type: 'completed', actorSubject: 'alice' }) });
  });

  it('the completed transition writes a Delivery row per email or webhook output in its transaction, then wakes the worker (GWP#6)', async () => {
    const outputs: DistributionOutput[] = [
      { id: 'hook', kind: 'webhook', config: { url: 'https://hooks.example.com/' } },
      { id: 'mail', kind: 'email', config: { recipients: ['a@example.com'] } },
      { id: 'file', kind: 'export', config: {} },
    ];
    const { service, tx, worker } = fakeProcess({ status: 'open', currentStepIndex: 0, rowVersion: 0, last: 'captured', steps: [], outputs });
    await service.advance('team-a', 'i1', 0, 'alice');
    expect(tx.delivery.createMany).toHaveBeenCalledWith({
      data: [
        { teamId: 'team-a', itemId: 'i1', outputId: 'hook', kind: 'webhook', idempotencyKey: 'i1:hook' },
        { teamId: 'team-a', itemId: 'i1', outputId: 'mail', kind: 'email', idempotencyKey: 'i1:mail' },
      ],
      skipDuplicates: true,
    });
    expect(tx.item.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'completed', waitingRole: null, sweepRetryAt: null, sweepFailures: 0, rowVersion: { increment: 1 } } }));
    expect(worker.kick).toHaveBeenCalledTimes(1);
  });

  it('output none clears the data in the completed transition and says so in the event (D-048)', async () => {
    const { service, tx } = fakeProcess({ status: 'open', currentStepIndex: 0, rowVersion: 0, last: 'captured', steps: [], outputs: [{ id: 'drop', kind: 'none', config: {} }] });
    await service.advance('team-a', 'i1', 0, 'alice');
    expect(tx.item.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'completed', waitingRole: null, sweepRetryAt: null, sweepFailures: 0, data: {}, rowVersion: { increment: 1 } } }));
    expect(tx.itemEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'completed', payload: { dataCleared: true } }) });
    expect(tx.delivery.createMany).toHaveBeenCalledWith({ data: [], skipDuplicates: true });
  });

  // GWP#23: an admin's edit of a failed item's data, or of one waiting at a human step.
  it('the data_edited payload names the changed keys only, never their values (D-048)', async () => {
    const { service, tx } = fakeProcess({ status: 'failed', currentStepIndex: 0, last: 'step_failed', data: { a: 1, b: 'kept', c: 'old-value' } });
    await service.editData('team-a', 'i1', 3, { a: 2, b: 'kept' }, 'admin');
    expect(tx.item.updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', teamId: 'team-a', rowVersion: 3 },
      data: { sweepRetryAt: null, sweepFailures: 0, data: { a: 2, b: 'kept' }, rowVersion: { increment: 1 } },
    });
    expect(tx.itemEvent.create).toHaveBeenCalledTimes(1);
    const { data: event } = (tx.itemEvent.create.mock.calls[0] as unknown as [{ data: { type: string; actorSubject: string; payload: unknown } }])[0];
    expect(event).toMatchObject({ seq: 5, type: 'data_edited', actorSubject: 'admin', payload: { fields: ['a', 'c'] } });
    for (const value of ['kept', 'old-value', '2', '1']) expect(JSON.stringify(event.payload)).not.toContain(value);
  });

  it('changedFields lists added, removed and changed keys, sorted', () => {
    expect(changedFields({ a: 1, b: 'x', c: true }, { a: 1, b: 'y', d: false })).toEqual(['b', 'c', 'd']);
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual([]);
    expect(changedFields({ a: 1 }, { a: '1' })).toEqual(['a']);
  });

  it('an edit that changes nothing writes nothing and answers the item', async () => {
    const { service, tx, items } = fakeProcess({ status: 'failed', currentStepIndex: 0, last: 'step_failed', data: { b: 'same' } });
    await service.editData('team-a', 'i1', 3, { b: 'same' }, 'admin');
    expect(tx.item.updateMany).not.toHaveBeenCalled();
    expect(items.get).toHaveBeenCalledWith('team-a', 'i1');
  });

  it('an edit of an item waiting at a human step is allowed; any other state, or a stale rowVersion, is 409 and writes nothing', async () => {
    const waiting = fakeProcess();
    await waiting.service.editData('team-a', 'i1', 3, { b: 'x' }, 'admin');
    expect(waiting.tx.itemEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'data_edited', payload: { fields: ['b'] } }) });
    const refusals = [
      fakeProcess({ status: 'completed', currentStepIndex: 3, last: 'completed' }),
      fakeProcess({ status: 'open', currentStepIndex: 0, last: 'captured' }),
      fakeProcess({ status: 'in_progress', currentStepIndex: 1, last: 'step_completed' }),
      fakeProcess({ status: 'in_progress', currentStepIndex: 0, last: 'step_started' }),
      fakeProcess({ status: 'cancelled', currentStepIndex: 0, last: 'step_started' }),
    ];
    for (const { service } of refusals) await expect(service.editData('team-a', 'i1', 3, { b: 'x' }, 'admin')).rejects.toBeInstanceOf(ConflictException);
    await expect(refusals[0]!.service.editData('team-a', 'i1', 3, { b: 'x' }, 'admin')).rejects.toThrow('This item is already completed');
    const stale = fakeProcess({ status: 'failed', currentStepIndex: 0, last: 'step_failed' });
    await expect(stale.service.editData('team-a', 'i1', 2, { b: 'x' }, 'admin')).rejects.toThrow(/changed since it was read/);
    for (const { tx } of [...refusals, stale]) expect(tx.item.updateMany).not.toHaveBeenCalled();
  });

  it('invalid data is 422 with errors keyed by field and writes nothing', async () => {
    const { service, tx } = fakeProcess({ status: 'failed', currentStepIndex: 0, last: 'step_failed' });
    const refused = service.editData('team-a', 'i1', 3, { a: 'not a number', z: 1 }, 'admin');
    await expect(refused).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(refused).rejects.toMatchObject({ response: { errors: { a: [expect.any(String)], z: ['Unknown field'] } } });
    expect(tx.item.updateMany).not.toHaveBeenCalled();
  });

  it('the engine reads the last transition event, past any data_edited', async () => {
    const { service, client } = fakeProcess();
    await service.advance('team-a', 'i1', 3, 'alice');
    expect(client.item.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ events: expect.objectContaining({ where: { type: { not: 'data_edited' } }, take: 1 }) }),
    }));
  });
});
