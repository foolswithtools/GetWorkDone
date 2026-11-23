import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { endDelivery, readDelivery, seedPendingDelivery, sharedDatabaseUrl } from '../../apps/api/test/support/scratch-database.js';
import { startApiServer, type ApiServer } from './support/api-server.js';

// Test isolation (GWP#26, docs/outputs.md): the e2e API's delivery worker claims every due pending
// Delivery row in its database, so it runs against a scratch database (support/global-setup.ts), never
// the one the integration partition leaves rows in. A due row is seeded in each; the worker ends the
// e2e one and never touches the shared one. Both point at the metadata address, which fails
// `blocked_address` without a DNS lookup.

let server: ApiServer | undefined;
const run = randomUUID().slice(0, 8);
const blocked = 'https://169.254.169.254/';
const shared = sharedDatabaseUrl();
let sharedRow: string;

test.afterAll(async () => {
  try {
    await server?.stop();
  } finally {
    if (sharedRow) await endDelivery(shared, sharedRow);
  }
});

test('the e2e worker sends its own database\'s due rows and leaves the integration database\'s alone', async () => {
  const own = process.env.DATABASE_URL;
  if (!own || own === shared) throw new Error('isolation.spec.ts needs the scratch DATABASE_URL from support/global-setup.ts');
  sharedRow = await seedPendingDelivery(shared, blocked);
  const ownRow = await seedPendingDelivery(own, blocked);
  server = await startApiServer({ sub: `e2e-iso-${run}`, email: `iso-${run}@example.test`, name: `Iso ${run}` });

  await expect.poll(async () => (await readDelivery(own, ownRow)).status, { timeout: 15_000 }).toBe('failed');
  expect(await readDelivery(shared, sharedRow)).toMatchObject({ status: 'pending', attempts: 0 });
});
