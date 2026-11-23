// Provision one environment's SLOs in the SLO app and their burn-rate rules in Grafana Alerting
// (slo/definitions.ts). The SLO app chooses an SLO's uuid, so SLOs are found by name.

import type { GrafanaClient, Json } from '../lib/grafana-client.js';
import type { Environment } from '../lib/environment.js';
import { reconcile, type Report } from '../lib/reconcile.js';
import { burnRateRules, sloDefinitions, toAlertRule, toGrafanaSlo } from './definitions.js';

const SLO_API = '/api/plugins/grafana-slo-app/resources/v1/slo';

export interface SloContext {
  grafana: GrafanaClient;
  environment: Environment;
  datasourceUid: string;
  report: Report;
}

export function planSlos(environment: Environment): string[] {
  return [
    ...sloDefinitions(environment).map((s) => `slo ${s.id}: ${Number((s.objective * 100).toFixed(2))} percent over ${s.window}, selector {${s.selector}}`),
    ...burnRateRules(environment).map(
      (r) => `burn-rate-rule ${r.uid} slo=${r.labels.slo} ${r.speed} ${r.factor}x over ${r.longWindow} and ${r.shortWindow}, severity ${r.severity}`,
    ),
  ];
}

export async function applySlos(ctx: SloContext): Promise<void> {
  for (const def of sloDefinitions(ctx.environment)) {
    const body = toGrafanaSlo(def, ctx.datasourceUid);
    let uuid: string | undefined;
    const read = async () => {
      if (uuid === undefined) uuid = (await ctx.grafana.get<{ slos?: Json[] }>(SLO_API))?.slos?.find((s) => s.name === body.name)?.uuid as string | undefined;
      return uuid === undefined ? undefined : ctx.grafana.get(`${SLO_API}/${uuid}`);
    };
    await reconcile(
      {
        kind: 'slo',
        name: body.name,
        desired: body,
        read,
        create: async () => {
          uuid = (await ctx.grafana.post<{ uuid?: string }>(SLO_API, body)).uuid;
        },
        update: () => ctx.grafana.put(`${SLO_API}/${String(uuid)}`, body),
      },
      ctx.report,
    );
  }
  for (const rule of burnRateRules(ctx.environment)) {
    const body = toAlertRule(rule, ctx.datasourceUid);
    await reconcile(
      {
        kind: 'burn-rate-rule',
        name: rule.uid,
        desired: body,
        read: () => ctx.grafana.get(`/api/v1/provisioning/alert-rules/${rule.uid}`),
        create: () => ctx.grafana.post('/api/v1/provisioning/alert-rules', body),
        update: () => ctx.grafana.put(`/api/v1/provisioning/alert-rules/${rule.uid}`, body),
      },
      ctx.report,
    );
  }
}
