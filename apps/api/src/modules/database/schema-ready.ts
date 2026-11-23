// Waiting for the database schema (GWP#101, docs/deploy/sandbox.md "Migrations"). An instance's first
// deploy starts the API on an empty database and migrates only afterwards, so a periodic job that
// queried its table at once would log `relation ... does not exist` at error on every run until the
// migration lands. Each job (the delivery worker, the session purge, the stuck-item sweeper, the
// delivery backlog gauge) instead waits with waitForSchema: it checks its table with schemaReady (the
// sweeper a column, with columnReady: GWP#127) at once, then after firstDelayMs, doubling up to 60 s,
// logs one `warn` (`<job> waiting for the database schema`) however many checks find no table (or
// column), and one `info` (`<job> started`) when it is there.
// Then it runs as before and never checks again: a table that vanishes later is a real error.
//
// In the sandbox the API connects as getworkdone_app, which the migrate task creates after the schema
// (#57), so on a fresh instance the check is first refused with 28P01 rather than finding no table. A
// refused login or a missing database (notProvisioned) is waited out the same way, under the same one
// `warn`. Any other failure (the database unreachable) cannot tell, so the job starts at once after one
// `warn`, and its runs fail and report as they did before GWP#101: the session purge's `status="error"`
// runs keep the telemetry heartbeat's series alive (docs/observability.md) while `database unreachable`
// names the cause. The API never migrates itself (README.md).
import { apiLogger } from '../../common/logger.js';
import type { Database } from './database.js';

/** The longest wait between two checks. */
export const SCHEMA_WAIT_MAX_MS = 60_000;

/** A table or column name that needs no escaping inside double quotes. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `table` exists in schema public: `SELECT to_regclass('public."<table>"')`. Needs no table privilege. */
export async function schemaReady(db: Database, table: string): Promise<boolean> {
  if (!NAME.test(table)) throw new Error(`not a table name: ${table}`);
  const [row] = await db.client.$queryRaw<{ ready: boolean }[]>`SELECT to_regclass(${`public."${table}"`}::text) IS NOT NULL AS ready`;
  return row?.ready === true;
}

/**
 * Whether `column` of `table` (schema public) exists: pg_catalog.pg_attribute for the relation
 * to_regclass names, so false, not an error, while the table is missing. For a job whose newest
 * migration adds a column rather than a table (the stuck-item sweeper, GWP#127). pg_attribute, not
 * information_schema.columns: that view lists only the columns of tables the role holds a privilege on,
 * while the catalog, like to_regclass, needs none.
 */
export async function columnReady(db: Database, table: string, column: string): Promise<boolean> {
  if (!NAME.test(table)) throw new Error(`not a table name: ${table}`);
  if (!NAME.test(column)) throw new Error(`not a column name: ${column}`);
  const [row] = await db.client.$queryRaw<{ ready: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass(${`public."${table}"`}::text) AND attname = ${column}::text AND NOT attisdropped) AS ready`;
  return row?.ready === true;
}

/** Postgres codes that mean the database is not provisioned for the API yet: login refused, no such database. */
const NOT_PROVISIONED = new Set(['28P01', '3D000']);
const NOT_PROVISIONED_KINDS = new Set(['AuthenticationFailed', 'DatabaseDoesNotExist']);

/**
 * Whether `error` is Postgres refusing the API's login or naming no such database, read from Prisma's
 * driver adapter error (`meta.driverAdapterError.cause`) or a bare `code`: a fresh instance before its
 * migrate task, not an outage.
 */
export function notProvisioned(error: unknown): boolean {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause;
  const code = cause?.originalCode ?? (error as { code?: unknown } | null)?.code;
  return NOT_PROVISIONED_KINDS.has(cause?.kind as string) || NOT_PROVISIONED.has(code as string);
}

/** The wait after the n-th check that found no table (n from 1): firstDelayMs, doubling, at most 60 s. */
export function schemaBackoffMs(firstDelayMs: number, checks: number): number {
  return Math.min(firstDelayMs * 2 ** (checks - 1), SCHEMA_WAIT_MAX_MS);
}

export interface SchemaWaitOptions {
  /** The job's name in its log lines, e.g. `delivery worker`. */
  job: string;
  /** The table the job needs, or `Table.column` for a column, for its log lines. */
  table: string;
  /** Resolves true once the table exists; schemaReady(db, table) in production. */
  check: () => Promise<boolean>;
  /** The first wait between checks: the job's own interval, capped at 60 s by the backoff. */
  firstDelayMs: number;
  /** Called once, when a check finds the table. */
  onReady: () => void;
}

export interface SchemaWait {
  /** True once a check found the table and onReady ran. */
  readonly ready: boolean;
  /** Resolves when the check in hand, if any, has answered. */
  settled(): Promise<void>;
  /** Cancels the next check and waits for the one in hand; onReady is never called after it. */
  stop(): Promise<void>;
}

/** Checks for the table now, then on the backoff until it exists; see the file comment. */
export function waitForSchema(options: SchemaWaitOptions): SchemaWait {
  let ready = false;
  let stopped = false;
  let warned = false;
  let failed = 0;
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<void> | undefined;

  const run = async () => {
    let exists: boolean;
    let refused: unknown;
    try {
      exists = await options.check();
    } catch (error) {
      if (stopped) return;
      if (notProvisioned(error)) {
        exists = false;
        refused = error;
      } else {
        apiLogger.warn({ table: options.table, err: error }, `${options.job} could not check the database schema; starting anyway`);
        exists = true;
      }
    }
    if (stopped) return;
    if (exists) {
      ready = true;
      apiLogger.info(`${options.job} started`);
      options.onReady();
      return;
    }
    if (!warned) {
      warned = true;
      apiLogger.warn(refused ? { table: options.table, err: refused } : { table: options.table }, `${options.job} waiting for the database schema`);
    }
    failed += 1;
    schedule(schemaBackoffMs(options.firstDelayMs, failed));
  };

  function check(): void {
    timer = undefined;
    checking = run().finally(() => {
      checking = undefined;
    });
  }

  function schedule(ms: number): void {
    timer = setTimeout(check, ms);
    timer.unref();
  }

  check();
  return {
    get ready() {
      return ready;
    },
    async settled() {
      await checking;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await checking;
    },
  };
}
