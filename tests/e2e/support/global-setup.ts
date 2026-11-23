import { createScratchDatabase, migrate, SHARED_DATABASE_ENV, sharedDatabaseUrl } from '../../../apps/api/test/support/scratch-database.js';

// Partition `e2e` (GWP#26, docs/outputs.md "Test isolation"): every API an e2e spec starts runs in
// production mode, and its delivery worker claims every due pending Delivery row in its database. So the
// run gets its own: a scratch database beside the one at DATABASE_URL, migrated here, handed to every
// spec through DATABASE_URL (the workers inherit this process's environment) and dropped at the end.
// The shared database is migrated too, as the integration partition does: isolation.spec.ts seeds a row
// in it. A run killed before its teardown leaves its scratch database behind.
export default async function setup(): Promise<() => Promise<void>> {
  const shared = sharedDatabaseUrl();
  migrate(shared);
  const database = await createScratchDatabase('e2e', shared);
  process.env[SHARED_DATABASE_ENV] = shared;
  process.env.DATABASE_URL = database.url;
  return () => database.drop();
}
