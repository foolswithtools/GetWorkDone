// Dashboards as code (GWP#7, D-027): one RED and SLO dashboard per environment, modelled on the
// exemplar's `exemplar-red` (observability/dashboards @ 12a071e). Every query is scoped to the
// environment's deployment_environment label and leaves synthetic traffic out, like the SLOs.
//
// Free tier (docs/observability.md, "Free-tier limits"): metrics are kept 14 days, so the panels look at
// hours, not the SLOs' 28-day window, and the 28-day attainment is read in the SLO app; series count
// against 10k active series, so panels aggregate and never split by item or team.
//
// Each panel shows one measure in one unit (no dual axes); Grafana's default palette colours the series
// and the threshold steps carry the burn factors and the latency SLO line.
//
// GWP#58: after the six panels, one row per SLO (sloDefinitions): its SLI over 5 minutes, its burn rate
// over the slow and fast rules' long windows (6 h and 1 h) with both factors as lines, and the budget its
// requests consumed over the dashboard's range, which the 14-day retention caps. Queries only, no new
// series. Ids are 10 x (row number) plus 0 to 4, so they stay stable while the SLO list keeps its order.

import { DEFAULT_DATASOURCE_UID } from '../lib/datasource.js';
import { ENVIRONMENT_LABEL, type Environment } from '../lib/environment.js';
import { DELIVERY_BACKLOG_THRESHOLD } from '../signals/definitions.js';
import { BURN_RATES, LATENCY_THRESHOLD_SECONDS, sloDefinitions } from '../slo/definitions.js';

type GridPos = { x: number; y: number; w: number; h: number };

export interface DataPanel {
  id: number;
  type: 'timeseries' | 'stat';
  title: string;
  description: string;
  gridPos: GridPos;
  datasource: { type: 'prometheus'; uid: string };
  fieldConfig: { defaults: { unit: string; min?: number; decimals?: number; thresholds?: { mode: 'absolute'; steps: { color: string; value: number | null }[] }; custom?: Record<string, unknown> }; overrides: [] };
  options?: Record<string, unknown>;
  targets: { refId: string; expr: string; legendFormat: string; instant?: boolean }[];
}

/** A row header: an uncollapsed row holds no panels of its own, the panels below it follow in the list. */
export interface RowPanel {
  id: number;
  type: 'row';
  title: string;
  collapsed: false;
  gridPos: GridPos;
  panels: [];
}

export type Panel = DataPanel | RowPanel;

export interface Dashboard {
  uid: string;
  title: string;
  tags: string[];
  timezone: 'utc';
  refresh: string;
  time: { from: string; to: string };
  schemaVersion: number;
  panels: Panel[];
}

const thresholdLines = { thresholdsStyle: { mode: 'line' } };

/** Where the SLO rows start: below the six panels' three rows of 8. */
const SLO_ROWS_Y = 24;

export function dashboards(environment: Environment, datasourceUid = DEFAULT_DATASOURCE_UID): Dashboard[] {
  const env = `${ENVIRONMENT_LABEL}="${environment}"`;
  const sel = `${env},synthetic="false",route=~"/api/v1/.*"`;
  const datasource = { type: 'prometheus' as const, uid: datasourceUid };
  const panel = (id: number, x: number, y: number, rest: Omit<DataPanel, 'id' | 'type' | 'gridPos' | 'datasource'>): DataPanel => ({
    id,
    type: 'timeseries',
    gridPos: { x, y, w: 12, h: 8 },
    datasource,
    ...rest,
  });
  const slos = sloDefinitions(environment);
  const [fast, slow] = BURN_RATES.map((r) => r.factor);
  const burnThresholds = { mode: 'absolute' as const, steps: [{ color: 'green', value: null }, { color: 'orange', value: slow ?? null }, { color: 'red', value: fast ?? null }] };
  const sloRows = slos.flatMap((slo, index): Panel[] => {
    const id = 10 * (index + 1);
    const y = SLO_ROWS_Y + index * 9;
    const budget = Number((1 - slo.objective).toFixed(6));
    const small = (offset: number, rest: Omit<DataPanel, 'id' | 'gridPos' | 'datasource'>): DataPanel => ({
      id: id + offset,
      gridPos: { x: (offset - 1) * 6, y: y + 1, w: 6, h: 8 },
      datasource,
      ...rest,
    });
    const burn = (offset: number, window: '1h' | '6h', rule: string): DataPanel =>
      small(offset, {
        type: 'timeseries',
        title: `${slo.id}: burn rate over ${window.replace('h', ' h')}`,
        description: `The ${rule} rule's long window. 1 means the budget lasts exactly 28 days. Lines at ${slow}x (slow burn, warning) and ${fast}x (fast burn, page).`,
        fieldConfig: { defaults: { unit: 'x', min: 0, custom: thresholdLines, thresholds: burnThresholds }, overrides: [] },
        targets: [{ refId: 'A', expr: `${slo.errorRatio(window)} / ${budget}`, legendFormat: `burn ${window}` }],
      });
    return [
      { id, type: 'row', title: slo.id, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] },
      small(1, {
        type: 'timeseries',
        title: `${slo.id}: SLI over 5 m`,
        description: `${slo.description} The share of good events over 5 minutes; the objective is ${slo.objective}.`,
        // The line is the objective: below it, the SLI is spending budget.
        fieldConfig: { defaults: { unit: 'percentunit', custom: thresholdLines, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: slo.objective }] } }, overrides: [] },
        targets: [{ refId: 'A', expr: `sum(rate(${slo.successQuery}[5m])) / sum(rate(${slo.totalQuery}[5m]))`, legendFormat: 'SLI' }],
      }),
      burn(2, '1h', 'fast'),
      burn(3, '6h', 'slow'),
      small(4, {
        type: 'stat',
        title: `${slo.id}: budget consumed over the dashboard range (at most 14 days)`,
        description:
          `1 - SLI over the dashboard's time range, divided by the budget ${budget} (1 - objective): 100 percent means the range's requests spent their share of the budget exactly. ` +
          'Metrics are kept 14 days (free tier), so a longer range still covers at most 14 days, not the 28-day SLO window; the SLO app shows the 28-day attainment.',
        fieldConfig: {
          defaults: { unit: 'percentunit', min: 0, decimals: 1, thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: 0.5 }, { color: 'red', value: 1 }] } },
          overrides: [],
        },
        options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'none', textMode: 'value' },
        targets: [{ refId: 'A', expr: `${slo.errorRatio('$__range')} / ${budget}`, legendFormat: 'budget consumed', instant: true }],
      }),
    ];
  });
  return [
    {
      uid: `${environment}-red`,
      title: `GetWorkDone RED and SLOs (${environment})`,
      tags: ['getworkdone', environment, 'slo'],
      timezone: 'utc',
      refresh: '1m',
      time: { from: 'now-6h', to: 'now' },
      schemaVersion: 39,
      panels: [
        panel(1, 0, 0, {
          title: 'Requests per second by status class',
          description: 'Rate: every /api/v1 request, real traffic only.',
          fieldConfig: { defaults: { unit: 'reqps', min: 0 }, overrides: [] },
          targets: [{ refId: 'A', expr: `sum by (status_class) (rate(http_server_requests_total{${sel}}[5m]))`, legendFormat: '{{status_class}}' }],
        }),
        panel(2, 12, 0, {
          title: '5xx share of requests',
          description: 'Errors: the availability SLO counts these against its 0.5 percent budget.',
          fieldConfig: { defaults: { unit: 'percentunit', min: 0 }, overrides: [] },
          targets: [{ refId: 'A', expr: `sum(rate(http_server_requests_total{${sel},status_class="5xx"}[5m])) / sum(rate(http_server_requests_total{${sel}}[5m]))`, legendFormat: '5xx share' }],
        }),
        panel(3, 0, 8, {
          title: 'p95 request duration',
          description: `Duration: the line is the latency SLO threshold, ${LATENCY_THRESHOLD_SECONDS} s.`,
          fieldConfig: {
            defaults: { unit: 's', min: 0, custom: thresholdLines, thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: LATENCY_THRESHOLD_SECONDS }] } },
            overrides: [],
          },
          targets: [{ refId: 'A', expr: `histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[5m])))`, legendFormat: 'p95' }],
        }),
        panel(4, 12, 8, {
          title: 'Error-budget burn rate over 1 h, per SLO',
          description: `Burn rate: 1 means the budget lasts exactly 28 days. Lines at ${slow}x (slow burn, warning) and ${fast}x (fast burn, page).`,
          fieldConfig: {
            defaults: {
              unit: 'x',
              min: 0,
              custom: thresholdLines,
              thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: slow ?? null }, { color: 'red', value: fast ?? null }] },
            },
            overrides: [],
          },
          targets: slos.map((slo, index) => ({
            refId: String.fromCharCode(65 + index),
            expr: `${slo.errorRatio('1h')} / ${Number((1 - slo.objective).toFixed(6))}`,
            legendFormat: slo.id,
          })),
        }),
        // GWP#53: the delivery series carry no route or synthetic label, only the environment.
        panel(5, 0, 16, {
          title: 'Deliveries per hour by kind and status',
          description: 'Delivery attempts over the last hour by output kind and outcome. A failed one is final and opens the delivery failed alert (warning).',
          fieldConfig: { defaults: { unit: 'short', min: 0 }, overrides: [] },
          targets: [{ refId: 'A', expr: `sum by (kind, status) (increase(distribution_deliveries_total{${env}}[1h]))`, legendFormat: '{{kind}} {{status}}' }],
        }),
        panel(6, 12, 16, {
          title: 'Pending deliveries',
          description: `Deliveries waiting for the worker; every task reports the same count, so the panel takes the max. The line is the backlog alert's ${DELIVERY_BACKLOG_THRESHOLD}, held for 30 minutes.`,
          fieldConfig: {
            defaults: {
              unit: 'short',
              min: 0,
              custom: thresholdLines,
              thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: DELIVERY_BACKLOG_THRESHOLD }] },
            },
            overrides: [],
          },
          targets: [{ refId: 'A', expr: `max by (${ENVIRONMENT_LABEL}) (distribution_deliveries_pending{${env}})`, legendFormat: 'pending' }],
        }),
        ...sloRows,
      ],
    },
  ];
}
