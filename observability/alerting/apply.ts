// Provision the alerting objects (alerting/definitions.ts): the folder, the OnCall contact point and the
// notification policy tree. The contact point's URL is the integration link oncall/apply.ts returned.

import type { GrafanaClient, Json } from '../lib/grafana-client.js';
import { reconcile, type Report } from '../lib/reconcile.js';
import { ALERT_FOLDER_TITLE, ALERT_FOLDER_UID, CONTACT_POINT_NAME, contactPoints, notificationPolicy } from './definitions.js';

export interface AlertingContext {
  grafana: GrafanaClient;
  report: Report;
}

export function planAlerting(): string[] {
  const policy = notificationPolicy();
  return [
    `folder ${ALERT_FOLDER_UID} (${ALERT_FOLDER_TITLE})`,
    `contact-point ${CONTACT_POINT_NAME} (oncall): url is the link of oncall-integration, read at apply time`,
    `notification-policy root -> ${String(policy.receiver)}; ${(policy.routes ?? []).map((r) => `${(r.object_matchers ?? []).map((m) => m.join('')).join(',')} -> ${String(r.receiver)}`).join('; ')}`,
  ];
}

export async function applyFolder(ctx: AlertingContext): Promise<void> {
  const desired = { uid: ALERT_FOLDER_UID, title: ALERT_FOLDER_TITLE };
  await reconcile(
    {
      kind: 'folder',
      name: ALERT_FOLDER_UID,
      desired,
      read: () => ctx.grafana.get(`/api/folders/${ALERT_FOLDER_UID}`),
      create: () => ctx.grafana.post('/api/folders', desired),
      update: () => ctx.grafana.put(`/api/folders/${ALERT_FOLDER_UID}`, { title: desired.title, overwrite: true }),
    },
    ctx.report,
  );
}

export async function applyAlerting(ctx: AlertingContext, integrationLink: string): Promise<void> {
  await applyFolder(ctx);
  for (const point of contactPoints(integrationLink)) {
    await reconcile(
      {
        kind: 'contact-point',
        name: point.name,
        desired: point,
        read: async () => (await ctx.grafana.get<Json[]>(`/api/v1/provisioning/contact-points?name=${encodeURIComponent(point.name)}`))?.find((c) => c.name === point.name),
        create: () => ctx.grafana.post('/api/v1/provisioning/contact-points', point),
        update: () => ctx.grafana.put(`/api/v1/provisioning/contact-points/${point.uid}`, point),
      },
      ctx.report,
    );
  }
  const policy = notificationPolicy();
  await reconcile(
    {
      kind: 'notification-policy',
      name: 'root',
      desired: policy,
      read: () => ctx.grafana.get('/api/v1/provisioning/policies'),
      // The stack always has a tree; "create" only happens if the read failed with 404.
      create: () => ctx.grafana.put('/api/v1/provisioning/policies', policy),
      update: () => ctx.grafana.put('/api/v1/provisioning/policies', policy),
    },
    ctx.report,
  );
}
