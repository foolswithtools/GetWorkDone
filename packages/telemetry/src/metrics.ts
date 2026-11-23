// RED metrics, ported from the exemplar-shop (packages/telemetry/src/metrics.ts @ 12a071e): the
// duration histogram (:61) with seconds buckets and the 0.8 s boundary (:66-68), the request counter
// (:76) and the shared labels (:97, :105-113), including `synthetic`, which the SLOs exclude (GWP#7,
// observability/slo/definitions.ts). The shop's business metrics are not ported.
//
//   - http_server_request_duration_seconds  (histogram, seconds buckets)
//   - http_server_requests_total            (counter)
//   labels on both: route, method, status_code, status_class, synthetic ("true" | "false")
//   - distribution_deliveries_total          (counter, GWP#6) labels: kind, status
//   - session_purge_runs_total               (counter, GWP#16) labels: status ("ok" | "error")
//   - session_purge_duration_seconds         (histogram, seconds buckets, GWP#16) labels: status
//   - session_purge_rows_deleted_total       (counter, GWP#16) labels: table ("LoginAttempt" | "Session" | "LoginRateWindow" | "QuotaWindow" | "Identity")
//   - database_ready                         (gauge, GWP#53) 1 when the last readiness check reached the database, else 0
//   - distribution_deliveries_pending        (observable gauge, GWP#53) Delivery rows still pending, read on each export
//   - process_sweeper_runs_total             (counter, GWP#55) labels: status ("ok" | "error")
//   - process_sweeper_items_total            (counter, GWP#55) labels: result ("resumed" | "skipped" | "failed")
//
// Instruments are created against whichever MeterProvider is global when first used, and cached per
// provider, so a provider registered later (setupOtel, a test) is never shadowed by a no-op one.

import { metrics } from '@opentelemetry/api';
import type { Attributes, Counter, Gauge, Histogram, MeterProvider, ObservableCallback, ObservableGauge } from '@opentelemetry/api';

/**
 * Seconds-scaled boundaries of http_server_request_duration_seconds: the SDK defaults are tuned for
 * milliseconds. 0.8 must stay a boundary: the latency SLO counts the `le="0.8"` bucket
 * (observability/slo/definitions.ts).
 */
export const HTTP_DURATION_BUCKETS: readonly number[] = [0.05, 0.1, 0.2, 0.4, 0.8, 1, 2, 5];

/** Meter name; the instrumentation scope reported alongside every metric. */
const METER_NAME = '@getworkdone/telemetry';

/**
 * Derive the `status_class` label ("2xx".."5xx") from a numeric HTTP status.
 * Unknown or out-of-range codes collapse to "5xx" so the error rate never under-counts.
 */
export function statusClassFor(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  return '5xx';
}

interface Instruments {
  duration: Histogram;
  requests: Counter;
  deliveries: Counter;
  purgeRuns: Counter;
  purgeDuration: Histogram;
  purgeRows: Counter;
  databaseReady: Gauge;
  deliveriesPending: ObservableGauge;
  sweepRuns: Counter;
  sweepItems: Counter;
}

const byProvider = new WeakMap<MeterProvider, Instruments>();

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  let found = byProvider.get(provider);
  if (!found) {
    const meter = provider.getMeter(METER_NAME);
    found = {
      duration: meter.createHistogram('http_server_request_duration_seconds', {
        description: 'HTTP server request duration in seconds (RED).',
        unit: 's',
        advice: { explicitBucketBoundaries: [...HTTP_DURATION_BUCKETS] },
      }),
      requests: meter.createCounter('http_server_requests_total', {
        description: 'Total HTTP server requests (RED count and errors).',
      }),
      deliveries: meter.createCounter('distribution_deliveries_total', {
        description: 'Distribution delivery attempts by output kind and outcome (GWP#6).',
      }),
      purgeRuns: meter.createCounter('session_purge_runs_total', {
        description: 'Runs of the expired sign-in and session purge, by outcome (GWP#16).',
      }),
      purgeDuration: meter.createHistogram('session_purge_duration_seconds', {
        description: 'Duration of the expired sign-in and session purge in seconds (GWP#16).',
        unit: 's',
        advice: { explicitBucketBoundaries: [...HTTP_DURATION_BUCKETS] },
      }),
      purgeRows: meter.createCounter('session_purge_rows_deleted_total', {
        description: 'Expired rows the session purge deleted, by table (GWP#16).',
      }),
      databaseReady: meter.createGauge('database_ready', {
        description: 'Whether the last readiness check reached the database: 1 or 0 (GWP#53).',
      }),
      deliveriesPending: meter.createObservableGauge('distribution_deliveries_pending', {
        description: 'Delivery rows with status pending, counted on each export (GWP#53).',
      }),
      sweepRuns: meter.createCounter('process_sweeper_runs_total', {
        description: 'Runs of the stuck-item sweeper, by outcome (GWP#55).',
      }),
      sweepItems: meter.createCounter('process_sweeper_items_total', {
        description: 'Items the stuck-item sweeper tried to advance, by result (GWP#55).',
      }),
    };
    byProvider.set(provider, found);
  }
  return found;
}

/**
 * Record one HTTP server request: the duration histogram and the request counter, sharing the same
 * labels. `status_class` is derived; do not pass it in. `route` is the route pattern, never a URL.
 * `synthetic` marks probe traffic (k6, synthetic checks), which the SLOs leave out; it defaults to false.
 */
export function recordHttpServerRequest(args: {
  route: string;
  method: string;
  statusCode: number;
  durationSeconds: number;
  synthetic?: boolean;
}): void {
  const labels: Attributes = {
    route: args.route,
    method: args.method,
    status_code: args.statusCode,
    status_class: statusClassFor(args.statusCode),
    synthetic: args.synthetic === true ? 'true' : 'false',
  };
  const { duration, requests } = instruments();
  duration.record(args.durationSeconds, labels);
  requests.add(1, labels);
}

/**
 * Record one delivery attempt of a distribution output (GWP#6, apps/api/src/modules/distribute): `kind`
 * is the output kind (`email`, `webhook`) and `status` the attempt's outcome (`delivered`, `retryable`,
 * `failed`).
 */
export function recordDistributionDelivery(args: { kind: string; status: 'delivered' | 'retryable' | 'failed' }): void {
  instruments().deliveries.add(1, { kind: args.kind, status: args.status });
}

/**
 * Start `distribution_deliveries_total{kind,status="failed"}` at 0 for each of `kinds` (GWP#53), at the
 * API's bootstrap. An OTel counter series is born at its first value, so without this a task's first
 * failed delivery would read 1, 1, 1 and the `<env> delivery failed` rule's `increase()` would see no
 * change and stay quiet.
 */
export function primeFailedDeliveries(kinds: readonly string[]): void {
  const { deliveries } = instruments();
  for (const kind of kinds) deliveries.add(0, { kind, status: 'failed' });
}

/**
 * Record one run of the expired sign-in and session purge (GWP#16, apps/api/src/modules/auth/session-purge.ts):
 * the run counter and duration by `status`, and, for a run that finished, the rows it deleted by table
 * (with the ended sign-in rate windows, GWP#32, the ended quota windows, GWP#50 and GWP#154, and the Identity rows past the
 * retention rule, GWP#143).
 */
export function recordSessionPurge(args: { status: 'ok' | 'error'; durationSeconds: number; deleted?: { loginAttempts: number; sessions: number; loginRateWindows: number; quotaWindows: number; identities: number } }): void {
  const { purgeRuns, purgeDuration, purgeRows } = instruments();
  purgeRuns.add(1, { status: args.status });
  purgeDuration.record(args.durationSeconds, { status: args.status });
  if (args.deleted) {
    purgeRows.add(args.deleted.loginAttempts, { table: 'LoginAttempt' });
    purgeRows.add(args.deleted.sessions, { table: 'Session' });
    purgeRows.add(args.deleted.loginRateWindows, { table: 'LoginRateWindow' });
    purgeRows.add(args.deleted.quotaWindows, { table: 'QuotaWindow' });
    purgeRows.add(args.deleted.identities, { table: 'Identity' });
  }
}

/**
 * Record one run of the stuck-item sweeper (GWP#55, apps/api/src/modules/process/stuck-item-sweeper.ts):
 * the run counter by `status`, and, for a run that finished, the items it tried by result: `resumed`
 * (advanced), `skipped` (moved by someone else first, or nothing to do) and `failed` (an error).
 */
export function recordProcessSweep(args: { status: 'ok' | 'error'; items?: { resumed: number; skipped: number; failed: number } }): void {
  const { sweepRuns, sweepItems } = instruments();
  sweepRuns.add(1, { status: args.status });
  if (args.items) {
    sweepItems.add(args.items.resumed, { result: 'resumed' });
    sweepItems.add(args.items.skipped, { result: 'skipped' });
    sweepItems.add(args.items.failed, { result: 'failed' });
  }
}

/**
 * Record the result of one readiness check of the database (GWP#53, apps/api/src/modules/health/readiness.ts):
 * `database_ready` 1 when it answered, 0 when it did not. The gauge keeps the last value between checks.
 */
export function recordDatabaseReady(ready: boolean): void {
  instruments().databaseReady.record(ready ? 1 : 0);
}

/** How long one export waits for the backlog count before it records nothing for that export. */
export const DELIVERY_BACKLOG_TIMEOUT_MS = 5000;

/**
 * Report `distribution_deliveries_pending` from `read` (GWP#53, apps/api/src/modules/distribute/delivery.backlog.ts),
 * called once per export. A read that rejects, or takes longer than `timeoutMs`, records nothing for that
 * export; under the API's cumulative temporality the exporter then repeats the last value it reported.
 * Every task counts the same table, so panels and rules take the max. Resolves the meter provider now;
 * returns the function that stops reporting.
 */
export function registerDeliveryBacklog(read: () => Promise<number>, { timeoutMs = DELIVERY_BACKLOG_TIMEOUT_MS }: { timeoutMs?: number } = {}): () => void {
  const gauge = instruments().deliveriesPending;
  const callback: ObservableCallback = async (result) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), timeoutMs);
    });
    try {
      const pending = await Promise.race([read(), timeout]);
      if (pending !== undefined) result.observe(pending);
    } catch {
      // The database is unreachable: database_ready and its rule say so; the gauge skips this export.
    } finally {
      clearTimeout(timer);
    }
  };
  gauge.addCallback(callback);
  return () => gauge.removeCallback(callback);
}
