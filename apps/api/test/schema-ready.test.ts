import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLogger } from '../src/common/logger.js';
import type { Database } from '../src/modules/database/database.js';
import { columnReady, notProvisioned, SCHEMA_WAIT_MAX_MS, schemaBackoffMs, schemaReady, waitForSchema } from '../src/modules/database/schema-ready.js';

// Partition `unit`: the schema check's query and the wait's backoff, logging and shutdown, with the
// database faked and fake timers (GWP#101); schema-ready.integration.test.ts runs it against Postgres.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function logs() {
  return {
    warn: vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined),
    info: vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined),
    error: vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined),
  };
}

describe('schemaReady', () => {
  it('asks to_regclass for the quoted table in schema public and answers whether it exists', async () => {
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [{ ready: false }]);
    const db = { client: { $queryRaw: queryRaw } } as unknown as Database;
    expect(await schemaReady(db, 'Delivery')).toBe(false);
    const [strings, ...values] = queryRaw.mock.calls[0]!;
    expect(strings.join('?')).toContain('to_regclass(');
    expect(values).toEqual(['public."Delivery"']);
    queryRaw.mockResolvedValueOnce([{ ready: true }]);
    expect(await schemaReady(db, 'Delivery')).toBe(true);
  });

  it('refuses a table name it would have to escape', async () => {
    const db = { client: { $queryRaw: vi.fn() } } as unknown as Database;
    await expect(schemaReady(db, 'Delivery"; --')).rejects.toThrow(/not a table name/);
  });
});

describe('columnReady (GWP#127)', () => {
  it('asks pg_attribute for the column of the quoted table in schema public, not information_schema, and answers whether it exists', async () => {
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [{ ready: false }]);
    const db = { client: { $queryRaw: queryRaw } } as unknown as Database;
    expect(await columnReady(db, 'Item', 'sweepRetryAt')).toBe(false);
    const [strings, ...values] = queryRaw.mock.calls[0]!;
    const sql = strings.join('?');
    expect(sql).toContain('pg_catalog.pg_attribute');
    expect(sql).toContain('to_regclass(');
    expect(sql).toContain('NOT attisdropped');
    expect(sql).not.toContain('information_schema');
    expect(values).toEqual(['public."Item"', 'sweepRetryAt']);
    queryRaw.mockResolvedValueOnce([{ ready: true }]);
    expect(await columnReady(db, 'Item', 'sweepRetryAt')).toBe(true);
  });

  it('refuses a table or column name it would have to escape', async () => {
    const queryRaw = vi.fn();
    const db = { client: { $queryRaw: queryRaw } } as unknown as Database;
    await expect(columnReady(db, 'Item"; --', 'sweepRetryAt')).rejects.toThrow(/not a table name/);
    await expect(columnReady(db, 'Item', 'sweepRetryAt"; --')).rejects.toThrow(/not a column name/);
    await expect(columnReady(db, 'Item', '')).rejects.toThrow(/not a column name/);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('schemaBackoffMs', () => {
  it('doubles from the first delay and stops at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => schemaBackoffMs(5_000, n))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(schemaBackoffMs(15 * 60_000, 1)).toBe(SCHEMA_WAIT_MAX_MS);
  });
});

describe('waitForSchema', () => {
  it('a table already there: one check, one info line, no warn, onReady once', async () => {
    vi.useFakeTimers();
    const log = logs();
    const onReady = vi.fn();
    const check = vi.fn(async () => true);
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check, firstDelayMs: 1_000, onReady });
    expect(wait.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.ready).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('test job started');
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * SCHEMA_WAIT_MAX_MS);
    expect(check).toHaveBeenCalledTimes(1);
    await wait.stop();
  });

  it('checks again with backoff, warns once however many checks fail, and starts when the table appears', async () => {
    vi.useFakeTimers();
    const log = logs();
    let exists = false;
    const at: number[] = [];
    const check = vi.fn(async () => {
      at.push(Date.now());
      return exists;
    });
    const onReady = vi.fn();
    const start = Date.now();
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check, firstDelayMs: 5_000, onReady });
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    expect(at.map((t) => t - start)).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ table: 'Thing' }, 'test job waiting for the database schema');
    expect(log.error).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    exists = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('test job started');
    expect(log.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * SCHEMA_WAIT_MAX_MS);
    expect(check).toHaveBeenCalledTimes(8);
    await wait.stop();
  });

  it('a check that throws cannot tell, so the job starts at once after one warn, and is never checked again', async () => {
    vi.useFakeTimers();
    const log = logs();
    const check = vi.fn(async (): Promise<boolean> => {
      throw new Error('connection refused');
    });
    const onReady = vi.fn();
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check, firstDelayMs: 1_000, onReady });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ table: 'Thing', err: expect.any(Error) }, 'test job could not check the database schema; starting anyway');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith('test job started');
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(wait.ready).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * SCHEMA_WAIT_MAX_MS);
    expect(check).toHaveBeenCalledTimes(1);
    await wait.stop();
  });

  it('a login the database refuses (the API role not created yet) or a missing database is waited out like a missing table', async () => {
    vi.useFakeTimers();
    const log = logs();
    const refused = Object.assign(new Error('Raw query failed. Code: `28P01`'), { code: 'P2010', meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '28P01', kind: 'AuthenticationFailed' } } } });
    const noDatabase = Object.assign(new Error('Raw query failed. Code: `3D000`'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '3D000', kind: 'DatabaseDoesNotExist' } } } });
    const answers: (Error | boolean)[] = [refused, noDatabase, refused, false, true];
    const check = vi.fn(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const onReady = vi.fn();
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check, firstDelayMs: 1_000, onReady });
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000);
    expect(check).toHaveBeenCalledTimes(5);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ table: 'Thing', err: refused }, 'test job waiting for the database schema');
    expect(log.error).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('test job started');
    await wait.stop();
  });

  it('notProvisioned: a refused login or a missing database, from the adapter error or a bare Postgres code', () => {
    expect(notProvisioned({ meta: { driverAdapterError: { cause: { kind: 'AuthenticationFailed' } } } })).toBe(true);
    expect(notProvisioned({ meta: { driverAdapterError: { cause: { originalCode: '3D000' } } } })).toBe(true);
    expect(notProvisioned({ code: '28P01' })).toBe(true);
    expect(notProvisioned({ meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } } } })).toBe(false);
    expect(notProvisioned(new Error('connection refused'))).toBe(false);
    expect(notProvisioned(undefined)).toBe(false);
  });

  it('a check that throws after stop starts nothing', async () => {
    vi.useFakeTimers();
    const log = logs();
    let fail!: (error: Error) => void;
    const onReady = vi.fn();
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check: () => new Promise<boolean>((_resolve, reject) => { fail = reject; }), firstDelayMs: 1_000, onReady });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = wait.stop();
    fail(new Error('connection refused'));
    await stopping;
    expect(onReady).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stop cancels the next check, waits for the one in hand and never calls onReady', async () => {
    vi.useFakeTimers();
    logs();
    let release!: (ready: boolean) => void;
    const check = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const onReady = vi.fn();
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check, firstDelayMs: 1_000, onReady });
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = wait.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release(true);
    await stopping;
    expect(onReady).not.toHaveBeenCalled();
    expect(wait.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * SCHEMA_WAIT_MAX_MS);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('settled resolves once the check in hand answers, or at once when none is in hand', async () => {
    vi.useFakeTimers();
    logs();
    let release!: (ready: boolean) => void;
    const wait = waitForSchema({ job: 'test job', table: 'Thing', check: () => new Promise<boolean>((resolve) => { release = resolve; }), firstDelayMs: 1_000, onReady: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    const settled = wait.settled();
    release(true);
    await settled;
    expect(wait.ready).toBe(true);
    await wait.settled();
    await wait.stop();
  });
});
