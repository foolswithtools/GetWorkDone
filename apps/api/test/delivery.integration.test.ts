import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { DeliveryResponse, ItemDetailResponse, WorkTypeDefinition, WorkTypeResponse } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { QuotaLimiter } from '../src/common/quota.js';
import { Database } from '../src/modules/database/database.js';
import { BACKOFF_MS, DeliveryWorker, LEASE_MS, MAX_ATTEMPTS } from '../src/modules/distribute/delivery.worker.js';
import { DISTRIBUTE_RUNTIME, type DistributeRuntime } from '../src/modules/distribute/distribute.options.js';
import { MemoryEmailTransport } from '../src/modules/distribute/email.adapter.js';
import type { OutputAdapter } from '../src/modules/distribute/output-adapter.js';
import { verifySignature } from '../src/modules/distribute/webhook.adapter.js';
import { signIn, type SignedIn } from './support/identity.js';
import { pullMetrics } from './support/metrics.js';
import { publicLookup, startReceiver, type Receiver } from './support/receiver.js';
import { fakeWebDist } from './support/web-dist.js';

// Distribution through the real routes and Postgres (GWP#6, docs/outputs.md): completing an item writes
// one Delivery row per email or webhook output in the same transaction; a worker claims due rows with
// SELECT ... FOR UPDATE SKIP LOCKED and sends each once, retrying a retryable failure at most three
// attempts in all before `failed` and a `delivery_failed` event. Clock and receiver are the test's.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `deliver-${name}-${run}`;
const fields: WorkTypeDefinition['fields'] = [{ key: 'title', label: 'Title', type: 'text', required: true }];

describe('delivery', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  const metrics = pullMetrics();
  const email = new MemoryEmailTransport();
  let receiver: Receiver;
  let clock: Date;
  let admin: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let worker: DeliveryWorker;
  let slugs = 0;

  async function workType(outputs: WorkTypeDefinition['outputs'], steps: WorkTypeDefinition['steps'] = []): Promise<WorkTypeResponse> {
    slugs += 1;
    return (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: `wt-${slugs}`, definition: { fields, steps, outputs } }).expect(201)).body as WorkTypeResponse;
  }
  async function capture(workTypeId: string, title = 'Fix the door'): Promise<ItemDetailResponse> {
    return (await admin.post(`/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data: { title } }).expect(201)).body as ItemDetailResponse;
  }
  const deliveries = async (itemId: string) => (await admin.get(`/api/v1/teams/${teamId}/items/${itemId}/deliveries`).expect(200)).body as DeliveryResponse[];
  const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
  const webhook = (id: string, path: string): WorkTypeDefinition['outputs'][number] => ({ id, kind: 'webhook', config: { url: `${receiver.origin}${path}` } });

  beforeAll(async () => {
    trace.setGlobalTracerProvider(provider);
    receiver = await startReceiver();
    app = await createApp({
      webDistDir: fakeWebDist(), logger: false,
      distribute: { webhook: { fetch: receiver.fetch, lookup: publicLookup }, email: { transport: email, from: 'noreply@example.com' }, now: () => clock },
    });
    await app.init();
    worker = app.get(DeliveryWorker);
    admin = await signIn(app, sub('admin'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Deliver' }).expect(201)).body.id;
  });
  beforeEach(() => {
    spans.reset();
    receiver.received.length = 0;
    // A second ahead of the database's clock, which stamps a new row's nextAttemptAt.
    clock = new Date(Date.now() + 1_000);
  });
  afterAll(async () => {
    await app.close();
    await receiver.close();
    await db.$disconnect();
    await provider.shutdown();
    await metrics.close();
    trace.disable();
  });

  it('completing an item with a webhook output produces exactly one POST carrying Idempotency-Key <itemId>:<outputId>', async () => {
    const created = await workType([webhook('hook', '/ok')]);
    const secret = created.webhookSecrets?.hook;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const item = await capture(created.id);
    expect(item.status).toBe('completed');
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ outputId: 'hook', kind: 'webhook', status: 'pending', attempts: 0 })]);

    await worker.runOnce({ itemIds: [item.id] });
    await worker.runOnce({ itemIds: [item.id] });
    later(LEASE_MS + BACKOFF_MS[2]!);
    await worker.runOnce({ itemIds: [item.id] });

    expect(receiver.received).toHaveLength(1);
    const [post] = receiver.received;
    expect(post?.headers['idempotency-key']).toBe(`${item.id}:hook`);
    expect(verifySignature(secret!, post?.body ?? '', post?.headers['x-getworkdone-signature'] as string)).toBe(true);
    expect(JSON.parse(post?.body ?? '')).toMatchObject({ item: { id: item.id, data: { title: 'Fix the door' } }, workType: { id: created.id, slug: created.slug, version: 1 } });
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'delivered', attempts: 1, lastError: null, deliveredAt: expect.any(String) })]);

    const span = spans.getFinishedSpans().find((s) => s.name === 'distribute.deliver');
    expect(span?.attributes).toMatchObject({ 'output.kind': 'webhook', 'delivery.attempt': 1, 'delivery.status': 'delivered' });
    expect(await metrics.counter('distribution_deliveries_total')).toEqual(expect.arrayContaining([{ attributes: { kind: 'webhook', status: 'delivered' }, value: expect.any(Number) }]));
  });

  it('the secret is shown once: never in a read, and a new version keeps it without showing it again', async () => {
    const created = await workType([webhook('hook', '/ok')]);
    const listed = (await admin.get(`/api/v1/teams/${teamId}/work-types`).expect(200)).body as WorkTypeResponse[];
    expect(listed.find((w) => w.id === created.id)).not.toHaveProperty('webhookSecrets');
    expect(JSON.stringify(listed)).not.toContain(created.webhookSecrets?.hook);
    const next = (await admin.post(`/api/v1/teams/${teamId}/work-types/${created.id}/versions`, { definition: { fields, steps: [], outputs: [webhook('hook', '/ok'), webhook('second', '/ok')] } }).expect(201)).body as WorkTypeResponse;
    expect(Object.keys(next.webhookSecrets ?? {})).toEqual(['second']);
    const stored = await db.outputSecret.findMany({ where: { workTypeId: created.id }, orderBy: { outputId: 'asc' } });
    expect(stored.map((s) => [s.outputId, s.secret])).toEqual([['hook', created.webhookSecrets?.hook], ['second', next.webhookSecrets?.second]]);
  });

  it('a webhook id removed and added again gets a new secret, shown once: never the old receiver\'s', async () => {
    const created = await workType([webhook('output_1', '/ok')]);
    const first = created.webhookSecrets?.output_1;
    const version = (outputs: WorkTypeDefinition['outputs']) => admin.post(`/api/v1/teams/${teamId}/work-types/${created.id}/versions`, { definition: { fields, steps: [], outputs } }).expect(201);
    expect((await version([{ id: 'keep', kind: 'persist', config: {} }])).body.webhookSecrets).toBeUndefined();
    const readded = (await version([webhook('output_1', '/ok')])).body as WorkTypeResponse;
    expect(readded.webhookSecrets?.output_1).toMatch(/^[0-9a-f]{64}$/);
    expect(readded.webhookSecrets?.output_1).not.toBe(first);
    expect((await db.outputSecret.findMany({ where: { workTypeId: created.id } })).map((s) => s.secret)).toEqual([readded.webhookSecrets?.output_1]);

    const item = await capture(created.id);
    await worker.runOnce({ itemIds: [item.id] });
    expect(verifySignature(readded.webhookSecrets!.output_1!, receiver.received[0]?.body ?? '', receiver.received[0]?.headers['x-getworkdone-signature'] as string)).toBe(true);
  });

  it('two workers racing one row send once', async () => {
    const created = await workType([webhook('hook', '/ok')]);
    const item = await capture(created.id);
    const runtime = app.get<DistributeRuntime>(DISTRIBUTE_RUNTIME);
    let sends = 0;
    const slow: OutputAdapter = {
      kind: 'webhook',
      async deliver(completed, config, ctx) {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return runtime.adapters.webhook.deliver(completed, config, ctx);
      },
    };
    const racers = [1, 2].map(() => new DeliveryWorker(app.get(Database), { ...runtime, adapters: { ...runtime.adapters, webhook: slow } }, app.get(QuotaLimiter)));
    await Promise.all(racers.map((racer) => racer.runOnce({ itemIds: [item.id] })));
    expect(sends).toBe(1);
    expect(receiver.received).toHaveLength(1);
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'delivered', attempts: 1 })]);
  });

  it('a crash after send but before commit resends with the same Idempotency-Key once the claim lapses', async () => {
    const created = await workType([webhook('hook', '/ok')]);
    const item = await capture(created.id);
    const runtime = app.get<DistributeRuntime>(DISTRIBUTE_RUNTIME);
    const crashing = new DeliveryWorker(app.get(Database), { ...runtime, afterSend: () => { throw new Error('crashed before commit'); } }, app.get(QuotaLimiter));
    await crashing.runOnce({ itemIds: [item.id] });
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'pending', attempts: 1 })]);

    await worker.runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(1);
    later(LEASE_MS);
    await worker.runOnce({ itemIds: [item.id] });

    expect(receiver.received.map((r) => r.headers['idempotency-key'])).toEqual([`${item.id}:hook`, `${item.id}:hook`]);
    expect(receiver.received[1]?.body).toBe(receiver.received[0]?.body);
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'delivered', attempts: 2 })]);
  });

  it('a crash during the last attempt never makes a fourth: the lapsed claim ends the row failed', async () => {
    const created = await workType([webhook('hook', '/fail')]);
    const item = await capture(created.id);
    await worker.runOnce({ itemIds: [item.id] });
    later(BACKOFF_MS[0]);
    await worker.runOnce({ itemIds: [item.id] });
    later(BACKOFF_MS[1]);
    const runtime = app.get<DistributeRuntime>(DISTRIBUTE_RUNTIME);
    await new DeliveryWorker(app.get(Database), { ...runtime, afterSend: () => { throw new Error('crashed before commit'); } }, app.get(QuotaLimiter)).runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(3);
    later(LEASE_MS);
    await worker.runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(3);
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'failed', attempts: 3, lastError: 'interrupted' })]);
    const events = await db.itemEvent.findMany({ where: { itemId: item.id, type: 'delivery_failed' } });
    expect(events.map((e) => e.payload)).toEqual([{ outputId: 'hook', kind: 'webhook', attempts: 3, reason: 'interrupted' }]);
  });

  it('three failures end in failed with a delivery_failed event, after 30 s and 2 min of backoff', async () => {
    expect([MAX_ATTEMPTS, ...BACKOFF_MS]).toEqual([3, 30_000, 120_000, 600_000]);
    const created = await workType([webhook('hook', '/fail')]);
    const item = await capture(created.id);

    await worker.runOnce({ itemIds: [item.id] });
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'pending', attempts: 1, lastError: 'http_503' })]);
    later(29_000);
    await worker.runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(1);
    later(1_000);
    await worker.runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(2);
    later(120_000);
    await worker.runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(3);
    later(600_000);
    await worker.runOnce({ itemIds: [item.id] });
    expect(receiver.received).toHaveLength(3);

    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'failed', attempts: 3, lastError: 'http_503' })]);
    const events = await db.itemEvent.findMany({ where: { itemId: item.id }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['captured', 'completed', 'delivery_failed']);
    expect(events[2]).toMatchObject({ seq: 3, actorSubject: null, payload: { outputId: 'hook', kind: 'webhook', attempts: 3, reason: 'http_503' } });
    expect(spans.getFinishedSpans().filter((s) => s.name === 'distribute.deliver').map((s) => s.attributes['delivery.attempt'])).toEqual([1, 2, 3]);
  });

  it('an output targeting https://169.254.169.254/ is saved but every attempt ends failed with reason blocked_address', async () => {
    const created = await workType([{ id: 'meta', kind: 'webhook', config: { url: 'https://169.254.169.254/' } }]);
    const item = await capture(created.id);
    await worker.runOnce({ itemIds: [item.id] });
    later(LEASE_MS + BACKOFF_MS[2]!);
    await worker.runOnce({ itemIds: [item.id] });
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'failed', attempts: 1, lastError: 'blocked_address' })]);
    const events = await db.itemEvent.findMany({ where: { itemId: item.id, type: 'delivery_failed' } });
    expect(events.map((e) => e.payload)).toEqual([{ outputId: 'meta', kind: 'webhook', attempts: 1, reason: 'blocked_address' }]);
  });

  it('two outputs failing at once each get their own event, with gap-free seq', async () => {
    const created = await workType([webhook('a', '/bad'), webhook('b', '/bad')]);
    const item = await capture(created.id);
    const runtime = app.get<DistributeRuntime>(DISTRIBUTE_RUNTIME);
    const racers = [1, 2].map(() => new DeliveryWorker(app.get(Database), runtime, app.get(QuotaLimiter)));
    await Promise.all(racers.map((racer) => racer.runOnce({ itemIds: [item.id] })));
    const events = await db.itemEvent.findMany({ where: { itemId: item.id }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, 'captured'], [2, 'completed'], [3, 'delivery_failed'], [4, 'delivery_failed']]);
  });

  it('an email output sends from the configured sender to the output\'s recipients', async () => {
    const created = await workType([{ id: 'mail', kind: 'email', config: { recipients: ['ops@example.com'] } }]);
    const item = await capture(created.id);
    await worker.runOnce({ itemIds: [item.id] });
    expect(email.sent.filter((m) => m.text.includes(item.id))).toEqual([expect.objectContaining({ from: 'noreply@example.com', to: ['ops@example.com'] })]);
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ kind: 'email', status: 'delivered' })]);
  });

  it('a human step: the rows are written when the item completes, not when it is captured', async () => {
    const created = await workType([webhook('hook', '/ok')], [{ id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' }]);
    const item = await capture(created.id);
    expect(await deliveries(item.id)).toEqual([]);
    await admin.post(`/api/v1/teams/${teamId}/items/${item.id}/steps/review/complete`, { rowVersion: item.rowVersion }).expect(200);
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(await worker.runOnce({ itemIds: [item.id] })).toBe(1);
    expect(await deliveries(item.id)).toEqual([expect.objectContaining({ status: 'delivered' })]);
  });

  it('persist keeps the data and sends nothing; none clears Item.data at completion and keeps the audit trail (D-048)', async () => {
    const kept = await capture((await workType([{ id: 'keep', kind: 'persist', config: {} }])).id);
    expect(kept.data).toEqual({ title: 'Fix the door' });
    expect(await deliveries(kept.id)).toEqual([]);

    const dropped = await capture((await workType([{ id: 'drop', kind: 'none', config: {} }])).id, 'Secret plans');
    expect(dropped.status).toBe('completed');
    expect(dropped.data).toEqual({});
    expect((await db.item.findUniqueOrThrow({ where: { id: dropped.id } })).data).toEqual({});
    expect(dropped.events.map((e) => e.type)).toEqual(['captured', 'completed']);
    expect(dropped.events[1]?.payload).toEqual({ dataCleared: true });
    expect(JSON.stringify(dropped.events)).not.toContain('Secret plans');
    expect(await deliveries(dropped.id)).toEqual([]);
  });

  it('a non-member cannot read an item\'s deliveries; another team\'s item is not found', async () => {
    const item = await capture((await workType([webhook('hook', '/ok')])).id);
    await outsider.get(`/api/v1/teams/${teamId}/items/${item.id}/deliveries`).expect(403);
    const otherTeam = (await outsider.post('/api/v1/teams', { name: 'Other' }).expect(201)).body.id as string;
    await outsider.get(`/api/v1/teams/${otherTeam}/items/${item.id}/deliveries`).expect(404);
    expect(await worker.runOnce({ itemIds: [item.id] })).toBe(1);
  });

  // Last in the file (GWP#26, docs/known-issues/2026-10-23-integration-deliveries-left-pending.md): a
  // pending row outlives the run, and the e2e API's worker, which claims every due row, would send it.
  it('leaves no Delivery row of this run pending', async () => {
    expect(await db.delivery.count({ where: { teamId, status: 'pending' } })).toBe(0);
  });
});
