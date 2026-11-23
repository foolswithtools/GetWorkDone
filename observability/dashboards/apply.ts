// Provision one environment's dashboards (dashboards/definitions.ts) into the GetWorkDone folder.

import { ALERT_FOLDER_UID } from '../alerting/definitions.js';
import type { Environment } from '../lib/environment.js';
import type { GrafanaClient, Json } from '../lib/grafana-client.js';
import { reconcile, type Report } from '../lib/reconcile.js';
import { dashboards } from './definitions.js';

export interface DashboardContext {
  grafana: GrafanaClient;
  environment: Environment;
  datasourceUid: string;
  report: Report;
}

export function planDashboards(environment: Environment): string[] {
  return dashboards(environment).map((d) => `dashboard ${d.uid}: ${d.panels.length} panels in folder ${ALERT_FOLDER_UID}`);
}

export async function applyDashboards(ctx: DashboardContext): Promise<void> {
  for (const dashboard of dashboards(ctx.environment, ctx.datasourceUid)) {
    const write = () => ctx.grafana.post('/api/dashboards/db', { dashboard, folderUid: ALERT_FOLDER_UID, overwrite: true, message: 'observability/apply.ts' });
    await reconcile(
      {
        kind: 'dashboard',
        name: dashboard.uid,
        desired: { dashboard, folderUid: ALERT_FOLDER_UID },
        read: () => ctx.grafana.get<Json>(`/api/dashboards/uid/${dashboard.uid}`),
        view: (found) => ({ dashboard: found.dashboard, folderUid: (found.meta as Json | undefined)?.folderUid }),
        create: write,
        update: write,
      },
      ctx.report,
    );
  }
}
