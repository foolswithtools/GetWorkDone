// @getworkdone/db: the Prisma schema, its migrations and the one shared Prisma client for Postgres
// (spec §4.3, D-026). Every database access in the API goes through createPrismaClient; the client is
// generated into src/generated/prisma by `prisma generate` (postinstall, build and typecheck run it).
import { PrismaPg } from '@prisma/adapter-pg';
import { rereadingPool, type CredentialRereadOptions } from './credentials.js';
import { databaseUrlFromEnv } from './database-url.js';
import { PrismaClient } from './generated/prisma/client.js';

export { Prisma, PrismaClient } from './generated/prisma/client.js';
export type { Delivery, Export, Identity, Item, ItemEvent, LoginAttempt, OutputSecret, Session, Team, TeamMember, WorkType, WorkTypeVersion } from './generated/prisma/client.js';
export { DeliveryStatus, ItemStatus, TeamRole } from './generated/prisma/enums.js';

export { DEFAULT_DATABASE_URL, databaseUrlFromEnv, type DatabaseUrlOptions } from './database-url.js';
export { RereadingPool, rereadingPool, type CredentialRereadOptions } from './credentials.js';

/** The URL the API's pg adapter connects to: DATABASE_URL, or the sandbox's parts (database-url.ts). */
export function databaseUrl(env: NodeJS.ProcessEnv): string {
  return databaseUrlFromEnv(env, { consumer: 'pg' });
}

/**
 * A Prisma client over the pg driver. It connects on its first query, so creating one needs no database.
 * With `reread`, the URL's password is the one the task started with, and a connection Postgres refuses
 * (28P01) re-reads the secret once and retries (credentials.ts, #66).
 */
export function createPrismaClient(url: string = databaseUrl(process.env), reread?: CredentialRereadOptions): PrismaClient {
  if (!reread) return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  // Given a pool, the adapter ends it on $disconnect only with disposeExternalPool; without it the pool's
  // connections outlive the client, with no listener left for an idle connection's error.
  return new PrismaClient({ adapter: new PrismaPg(rereadingPool(url, reread), { disposeExternalPool: true }) });
}
