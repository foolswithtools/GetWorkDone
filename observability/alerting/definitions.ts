// Alerting as code (GWP#7, D-027, D-042): the folder the SLO rules live in, the one contact point and the
// notification policy tree. The exemplar's contact points were email placeholders at .invalid addresses
// (observability/alerting/definitions.ts:38-53 @ 12a071e; prebutton.md:348), so nothing paged. Here the
// only contact point is the OnCall integration apply.ts creates, and its URL is that integration's link.

import { ENVIRONMENT_LABEL, TEAM } from '../lib/environment.js';

export const ALERT_FOLDER_UID = 'getworkdone';
export const ALERT_FOLDER_TITLE = 'GetWorkDone';
export const CONTACT_POINT_NAME = 'getworkdone-oncall';

export interface ContactPoint {
  uid: string;
  name: string;
  type: 'oncall';
  settings: { url: string };
  disableResolveMessage: boolean;
}

/** The contact points; `oncallUrl` is the link of the OnCall integration apply.ts created or found. */
export function contactPoints(oncallUrl: string): ContactPoint[] {
  let url: URL | undefined;
  try {
    url = new URL(oncallUrl);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.hostname.endsWith('.invalid')) {
    throw new Error(`the contact point URL must be the https link of the OnCall integration, not ${JSON.stringify(oncallUrl)}`);
  }
  return [{ uid: CONTACT_POINT_NAME, name: CONTACT_POINT_NAME, type: 'oncall', settings: { url: oncallUrl }, disableResolveMessage: false }];
}

export type Matcher = [label: string, operator: '=' | '!=' | '=~' | '!~', value: string];

export interface Route {
  receiver?: string;
  object_matchers?: Matcher[];
  group_by?: string[];
  group_wait?: string;
  group_interval?: string;
  repeat_interval?: string;
  continue?: boolean;
  routes?: Route[];
}

/**
 * The whole policy tree (the provisioning API replaces it on PUT). `team=getworkdone` alerts, which every
 * SLO rule carries, route to OnCall. The root's receiver is OnCall too, so nothing falls back to the
 * stack's default email contact point.
 */
export function notificationPolicy(): Route {
  return {
    receiver: CONTACT_POINT_NAME,
    group_by: ['grafana_folder', 'alertname'],
    routes: [
      {
        receiver: CONTACT_POINT_NAME,
        object_matchers: [['team', '=', TEAM]],
        group_by: ['alertname', 'slo', ENVIRONMENT_LABEL],
        group_wait: '30s',
        group_interval: '5m',
        repeat_interval: '4h',
        // `continue` stays unset (false): Grafana omits a false one when the tree is read back.
      },
    ],
  };
}

function matches([label, operator, value]: Matcher, labels: Record<string, string>): boolean {
  const actual = labels[label] ?? '';
  switch (operator) {
    case '=':
      return actual === value;
    case '!=':
      return actual !== value;
    case '=~':
      return new RegExp(`^(?:${value})$`).test(actual);
    case '!~':
      return !new RegExp(`^(?:${value})$`).test(actual);
  }
}

/**
 * The routes an alert with `labels` walks, root first, as Alertmanager matches them: into the first
 * child whose matchers all hold, then that child's children. A one-element result means only the root
 * matched.
 */
export function matchRoute(tree: Route, labels: Record<string, string>): Route[] {
  const path = [tree];
  let node = tree;
  for (;;) {
    const next = (node.routes ?? []).find((child) => (child.object_matchers ?? []).every((m) => matches(m, labels)));
    if (!next) return path;
    path.push(next);
    node = next;
  }
}
