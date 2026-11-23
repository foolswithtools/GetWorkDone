import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLogger } from '../src/common/logger.js';
import { SessionPurge, sessionPurgeOptionsFromEnv } from '../src/modules/auth/session-purge.js';
import type { SessionsService } from '../src/modules/auth/sessions.service.js';

// Partition `unit`: the purge's schedule and error handling with SessionsService stubbed;
// session-purge.integration.test.ts runs the deletes against Postgres (GWP#16).

function sessionsStub(purgeExpired: SessionsService['purgeExpired']) {
  return { purgeExpired: vi.fn(purgeExpired) } as unknown as SessionsService & { purgeExpired: ReturnType<typeof vi.fn> };
}

const counts = async () => ({ loginAttempts: 1, sessions: 2, loginRateWindows: 3, quotaWindows: 4, identities: 5 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionPurge', () => {
  it('runs once at bootstrap and then every intervalMs, with its clock', async () => {
    vi.useFakeTimers();
    const sessions = sessionsStub(counts);
    const now = new Date('2026-10-23T12:00:00Z');
    const purge = new SessionPurge(sessions, { autoRun: true, intervalMs: 1_000, now: () => now });
    purge.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(1);
    expect(sessions.purgeExpired).toHaveBeenCalledWith(now);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(3);
    await purge.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(3);
  });

  it('does nothing on its own when autoRun is off; runOnce still purges and returns the counts', async () => {
    vi.useFakeTimers();
    const sessions = sessionsStub(counts);
    const purge = new SessionPurge(sessions, { autoRun: false, intervalMs: 1_000 });
    purge.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sessions.purgeExpired).not.toHaveBeenCalled();
    expect(await purge.runOnce()).toEqual({ loginAttempts: 1, sessions: 2, loginRateWindows: 3, quotaWindows: 4, identities: 5 });
    await purge.onModuleDestroy();
  });

  it('a run logs the rows deleted from each table, the Identity rows past the retention rule included (GWP#143)', async () => {
    const info = vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    await new SessionPurge(sessionsStub(counts), { autoRun: false, intervalMs: 1_000 }).runOnce();
    expect(info).toHaveBeenCalledExactlyOnceWith(
      { login_attempts_deleted: 1, sessions_deleted: 2, login_rate_windows_deleted: 3, quota_windows_deleted: 4, identities_deleted: 5, duration_ms: expect.any(Number) },
      'session purge',
    );
  });

  it('a tick while a run is in flight starts no second run, and shutdown waits for the run in hand', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const sessions = sessionsStub(() => new Promise((resolve) => { release = () => resolve({ loginAttempts: 0, sessions: 0, loginRateWindows: 0, quotaWindows: 0, identities: 0 }); }));
    const purge = new SessionPurge(sessions, { autoRun: true, intervalMs: 1_000 });
    purge.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = purge.onModuleDestroy().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('a failed run is logged and recorded, never thrown, and the next tick runs again', async () => {
    vi.useFakeTimers();
    let fail = true;
    const sessions = sessionsStub(async () => {
      if (fail) throw new Error('db down');
      return { loginAttempts: 0, sessions: 0, loginRateWindows: 0, quotaWindows: 0, identities: 0 };
    });
    const logged = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const purge = new SessionPurge(sessions, { autoRun: true, intervalMs: 1_000 });
    purge.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'session purge failed');
    logged.mockRestore();
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(2);
    await expect(new SessionPurge(sessionsStub(async () => { throw new Error('db down'); }), { autoRun: false, intervalMs: 1_000 }).runOnce()).rejects.toThrow('db down');
    await purge.onModuleDestroy();
  });
});

describe('SessionPurge before the schema exists (GWP#101)', () => {
  it('purges nothing while its tables are absent, warns once, then logs started and runs on its interval', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    let exists = false;
    const tableReady = vi.fn(async () => exists);
    const sessions = sessionsStub(counts);
    const purge = new SessionPurge(sessions, { autoRun: true, intervalMs: 15 * 60_000, tableReady });
    purge.onApplicationBootstrap();
    // Checks at 0 and then every 60 s (the 15-minute interval is capped by the backoff).
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(tableReady).toHaveBeenCalledTimes(4);
    expect(sessions.purgeExpired).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ table: 'Identity' }, 'session purge waiting for the database schema');
    expect(error).not.toHaveBeenCalled();
    exists = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledWith('session purge started');
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(2);
    expect(tableReady).toHaveBeenCalledTimes(5);
    await purge.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(2);
  });

  it('with the database unreachable it still runs at startup (each failed run records status="error", which keeps the heartbeat series alive)', async () => {
    vi.useFakeTimers();
    vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const sessions = sessionsStub(async () => { throw new Error('connection refused'); });
    const purge = new SessionPurge(sessions, { autoRun: true, intervalMs: 1_000, tableReady: () => Promise.reject(new Error('connection refused')) });
    purge.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.purgeExpired).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'session purge failed');
    await purge.onModuleDestroy();
  });

  it('shutdown while it waits cancels the wait', async () => {
    vi.useFakeTimers();
    vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const tableReady = vi.fn(async () => false);
    const sessions = sessionsStub(counts);
    const purge = new SessionPurge(sessions, { autoRun: true, intervalMs: 1_000, tableReady });
    purge.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await purge.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tableReady).toHaveBeenCalledTimes(1);
    expect(sessions.purgeExpired).not.toHaveBeenCalled();
  });
});

describe('sessionPurgeOptionsFromEnv', () => {
  it('every 15 minutes unless SESSION_PURGE_MS is a positive whole number; off under NODE_ENV=test', () => {
    expect(sessionPurgeOptionsFromEnv({})).toMatchObject({ autoRun: true, intervalMs: 900_000 });
    expect(sessionPurgeOptionsFromEnv({ SESSION_PURGE_MS: '60000', NODE_ENV: 'production' })).toMatchObject({ autoRun: true, intervalMs: 60_000 });
    for (const bad of ['0', '-5', '1.5', 'often']) expect(sessionPurgeOptionsFromEnv({ SESSION_PURGE_MS: bad }).intervalMs, bad).toBe(900_000);
    expect(sessionPurgeOptionsFromEnv({ NODE_ENV: 'test' }).autoRun).toBe(false);
  });
});
