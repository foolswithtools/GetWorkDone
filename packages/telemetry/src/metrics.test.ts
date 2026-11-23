import { metrics } from '@opentelemetry/api';
import { DataPointType, MeterProvider, MetricReader, type HistogramMetricData } from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELIVERY_BACKLOG_TIMEOUT_MS, HTTP_DURATION_BUCKETS, primeFailedDeliveries, recordDatabaseReady, recordDistributionDelivery, recordHttpServerRequest, recordProcessSweep, recordSessionPurge, registerDeliveryBacklog, statusClassFor } from './metrics.js';

// A reader the test pulls from on demand.
class PullReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

const reader = new PullReader();
const provider = new MeterProvider({ readers: [reader] });

beforeAll(() => {
  metrics.setGlobalMeterProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

async function collect(name: string) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
}

describe('RED metrics', () => {
  it('0.8 is a bucket boundary of http_server_request_duration_seconds', async () => {
    recordHttpServerRequest({ route: '/healthz', method: 'GET', statusCode: 200, durationSeconds: 0.5 });
    const h = (await collect('http_server_request_duration_seconds')) as HistogramMetricData | undefined;
    expect(h?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(h?.descriptor.unit).toBe('s');
    expect(h?.dataPoints[0]?.value.buckets.boundaries).toEqual([0.05, 0.1, 0.2, 0.4, 0.8, 1, 2, 5]);
    // The SLO definitions read the boundaries from here (observability/test/definitions.test.ts).
    expect(HTTP_DURATION_BUCKETS).toEqual([0.05, 0.1, 0.2, 0.4, 0.8, 1, 2, 5]);
  });

  it('http_server_requests_total carries route, method, status_code and the derived status_class', async () => {
    recordHttpServerRequest({ route: '/api/x', method: 'POST', statusCode: 503, durationSeconds: 0.1 });
    const counter = await collect('http_server_requests_total');
    const point = counter?.dataPoints.find((p) => p.attributes.route === '/api/x');
    expect(point?.attributes).toEqual({ route: '/api/x', method: 'POST', status_code: 503, status_class: '5xx', synthetic: 'false' });
    expect(point?.value).toBe(1);
  });

  it('a synthetic request is labelled synthetic="true" on both RED instruments; the SLOs select synthetic="false"', async () => {
    recordHttpServerRequest({ route: '/api/probe', method: 'GET', statusCode: 200, durationSeconds: 0.1, synthetic: true });
    const counter = await collect('http_server_requests_total');
    expect(counter?.dataPoints.find((p) => p.attributes.route === '/api/probe')?.attributes.synthetic).toBe('true');
    const h = (await collect('http_server_request_duration_seconds')) as HistogramMetricData | undefined;
    expect(h?.dataPoints.find((p) => p.attributes.route === '/api/probe')?.attributes.synthetic).toBe('true');
  });

  it('statusClassFor maps codes to classes and anything unknown to 5xx', () => {
    expect([200, 301, 404, 500, 99, 600].map(statusClassFor)).toEqual(['2xx', '3xx', '4xx', '5xx', '5xx', '5xx']);
  });
});

describe('distribution metrics (GWP#6)', () => {
  it('distribution_deliveries_total counts each attempt by output kind and outcome', async () => {
    recordDistributionDelivery({ kind: 'webhook', status: 'retryable' });
    recordDistributionDelivery({ kind: 'webhook', status: 'delivered' });
    recordDistributionDelivery({ kind: 'webhook', status: 'delivered' });
    const counter = await collect('distribution_deliveries_total');
    const points = (counter?.dataPoints ?? []).map((p) => [p.attributes, p.value]);
    expect(points).toEqual(expect.arrayContaining([[{ kind: 'webhook', status: 'retryable' }, 1], [{ kind: 'webhook', status: 'delivered' }, 2]]));
  });
});

describe('failed-delivery series (GWP#53)', () => {
  it('primeFailedDeliveries starts distribution_deliveries_total{status="failed"} at 0 for each kind, so the first failure is an increase', async () => {
    primeFailedDeliveries(['email', 'sms']);
    const points = ((await collect('distribution_deliveries_total'))?.dataPoints ?? []).map((p) => [p.attributes, p.value]);
    expect(points).toEqual(expect.arrayContaining([[{ kind: 'email', status: 'failed' }, 0], [{ kind: 'sms', status: 'failed' }, 0]]));
    recordDistributionDelivery({ kind: 'sms', status: 'failed' });
    const after = ((await collect('distribution_deliveries_total'))?.dataPoints ?? []).find((p) => p.attributes.kind === 'sms');
    expect(after?.value).toBe(1);
  });
});

describe('session purge metrics (GWP#16, GWP#32, GWP#143, GWP#154)', () => {
  it('session_purge_runs_total, session_purge_duration_seconds and session_purge_rows_deleted_total record each purge run', async () => {
    recordSessionPurge({ status: 'ok', durationSeconds: 0.02, deleted: { loginAttempts: 3, sessions: 2, loginRateWindows: 5, quotaWindows: 4, identities: 7 } });
    recordSessionPurge({ status: 'ok', durationSeconds: 0.01, deleted: { loginAttempts: 1, sessions: 0, loginRateWindows: 1, quotaWindows: 2, identities: 1 } });
    recordSessionPurge({ status: 'error', durationSeconds: 0.5 });
    const runs = await collect('session_purge_runs_total');
    expect((runs?.dataPoints ?? []).map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([[{ status: 'ok' }, 2], [{ status: 'error' }, 1]]));
    const rows = await collect('session_purge_rows_deleted_total');
    expect((rows?.dataPoints ?? []).map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([[{ table: 'LoginAttempt' }, 4], [{ table: 'Session' }, 2], [{ table: 'LoginRateWindow' }, 6], [{ table: 'QuotaWindow' }, 6], [{ table: 'Identity' }, 8]]));
    const duration = (await collect('session_purge_duration_seconds')) as HistogramMetricData | undefined;
    expect(duration?.descriptor.unit).toBe('s');
    expect(duration?.dataPoints.find((p) => p.attributes.status === 'error')?.value.count).toBe(1);
  });
});

describe('stuck-item sweeper (GWP#55)', () => {
  it('process_sweeper_runs_total and process_sweeper_items_total record each sweep and its items by result', async () => {
    recordProcessSweep({ status: 'ok', items: { resumed: 2, skipped: 1, failed: 0 } });
    recordProcessSweep({ status: 'ok', items: { resumed: 1, skipped: 0, failed: 3 } });
    recordProcessSweep({ status: 'error' });
    const runs = await collect('process_sweeper_runs_total');
    expect((runs?.dataPoints ?? []).map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([[{ status: 'ok' }, 2], [{ status: 'error' }, 1]]));
    const items = await collect('process_sweeper_items_total');
    expect((items?.dataPoints ?? []).map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([[{ result: 'resumed' }, 3], [{ result: 'skipped' }, 1], [{ result: 'failed' }, 3]]));
  });
});

describe('readiness and backlog gauges (GWP#53)', () => {
  const value = async (name: string) => (await collect(name))?.dataPoints.map((p) => p.value);

  it('database_ready records 1 then 0', async () => {
    recordDatabaseReady(true);
    expect(await value('database_ready')).toEqual([1]);
    recordDatabaseReady(false);
    expect(await value('database_ready')).toEqual([0]);
  });

  it("distribution_deliveries_pending reports the callback's value on each export", async () => {
    let pending = 2;
    const unregister = registerDeliveryBacklog(async () => pending);
    try {
      expect(await value('distribution_deliveries_pending')).toEqual([2]);
      pending = 1;
      expect(await value('distribution_deliveries_pending')).toEqual([1]);
    } finally {
      unregister();
    }
  });

  // A provider that has never seen the gauge: under cumulative temporality the SDK re-reports a gauge's
  // last observation when a callback observes nothing, so a skip shows only before the first value.
  async function onFreshProvider(run: (collectFresh: () => Promise<unknown[] | undefined>) => Promise<void>): Promise<void> {
    const freshReader = new PullReader();
    const fresh = new MeterProvider({ readers: [freshReader] });
    metrics.disable();
    metrics.setGlobalMeterProvider(fresh);
    try {
      await run(async () => {
        const { resourceMetrics } = await freshReader.collect();
        return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === 'distribution_deliveries_pending')?.dataPoints.map((p) => p.value);
      });
    } finally {
      await fresh.shutdown();
      metrics.disable();
      metrics.setGlobalMeterProvider(provider);
    }
  }

  it('distribution_deliveries_pending skips an export whose callback rejects or exceeds the timeout', async () => {
    expect(DELIVERY_BACKLOG_TIMEOUT_MS).toBe(5000);
    await onFreshProvider(async (collectFresh) => {
      const rejected = registerDeliveryBacklog(() => Promise.reject(new Error('database down')));
      try {
        expect(await collectFresh()).toBeUndefined();
      } finally {
        rejected();
      }
    });
    await onFreshProvider(async (collectFresh) => {
      let timer: NodeJS.Timeout | undefined;
      const slow = registerDeliveryBacklog(() => new Promise<number>((done) => (timer = setTimeout(() => done(7), 1000))), { timeoutMs: 20 });
      try {
        const started = performance.now();
        expect(await collectFresh()).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(900);
      } finally {
        slow();
        clearTimeout(timer);
      }
    });
  });

  it('an unregistered callback is no longer read', async () => {
    let reads = 0;
    const unregister = registerDeliveryBacklog(async () => ++reads);
    await collect('distribution_deliveries_pending');
    unregister();
    await collect('distribution_deliveries_pending');
    expect(reads).toBe(1);
  });
});
