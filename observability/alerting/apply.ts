// Provision the alerting objects (alerting/definitions.ts): the folder, the OnCall contact point and the
// team=getworkdone route of the notification policy tree. The contact point's URL is the integration
// link oncall/apply.ts returned. The stack is shared, so the tree is read, merged and written back
// (mergePolicy, GWP#171): other tenants' routes and a root receiver that is not the default stay.

import type { GrafanaClient, Json } from '../lib/grafana-client.js';
import { reconcile, type Report } from '../lib/reconcile.js';
import { ALERT_FOLDER_TITLE, ALERT_FOLDER_UID, CONTACT_POINT_NAME, contactPoints, mergePolicy, ownedRoute, type Route } from './definitions.js';

export interface AlertingContext {
  grafana: GrafanaClient;
  report: Report;
}

export function planAlerting(): string[] {
  const route = ownedRoute();
  return [
    `folder ${ALERT_FOLDER_UID} (${ALERT_FOLDER_TITLE})`,
    `contact-point ${CONTACT_POINT_NAME} (oncall): url is the link of oncall-integration, read at apply time`,
    `notification-policy root: merge ${(route.object_matchers ?? []).map((m) => m.join('')).join(',')} -> ${String(route.receiver)} into the stack's tree, keeping other routes; root -> ${CONTACT_POINT_NAME} only if it is the stack default`,
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
  const POLICIES = '/api/v1/provisioning/policies';
  // The stack always has a tree; a 404 is merged as an empty one: the OnCall root and the owned route.
  const live = await ctx.grafana.get<Route>(POLICIES);
  const { tree, rootNote } = mergePolicy(live ?? {});
  if (rootNote !== undefined) ctx.report(`notification-policy root: ${rootNote}`);
  await reconcile(
    {
      kind: 'notification-policy',
      name: 'root',
      desired: tree,
      read: () => ctx.grafana.get(POLICIES),
      create: () => ctx.grafana.put(POLICIES, tree),
      update: () => ctx.grafana.put(POLICIES, tree),
    },
    ctx.report,
  );
}
