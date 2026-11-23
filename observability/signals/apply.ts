// Provision one environment's signal rules (signals/definitions.ts) in Grafana Alerting, as the group
// `<env>-signals` in the folder the burn-rate rules use.

import type { Environment } from '../lib/environment.js';
import type { GrafanaClient } from '../lib/grafana-client.js';
import { reconcile, type Report } from '../lib/reconcile.js';
import { signalRules, toSignalAlertRule } from './definitions.js';

export interface SignalContext {
  grafana: GrafanaClient;
  environment: Environment;
  datasourceUid: string;
  report: Report;
}

export function planSignals(environment: Environment): string[] {
  return signalRules(environment).map(
    (r) => `signal-rule ${r.uid} group ${environment}-signals: ${r.labels.severity}, for ${r.for}, ${r.expr}`,
  );
}

export async function applySignals(ctx: SignalContext): Promise<void> {
  for (const rule of signalRules(ctx.environment)) {
    const body = toSignalAlertRule(rule, ctx.datasourceUid);
    await reconcile(
      {
        kind: 'signal-rule',
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
