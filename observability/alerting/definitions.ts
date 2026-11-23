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

/** The receivers a stack's root has before anyone sets it: Grafana's default email point, or none. */
export const DEFAULT_ROOT_RECEIVERS: readonly string[] = ['grafana-default-email', ''];

/**
 * The one top-level route this code owns (GWP#171). `team=getworkdone` alerts, which every SLO and
 * signal rule carries, route to OnCall.
 */
export function ownedRoute(): Route {
  return {
    receiver: CONTACT_POINT_NAME,
    object_matchers: [['team', '=', TEAM]],
    group_by: ['alertname', 'slo', ENVIRONMENT_LABEL],
    group_wait: '30s',
    group_interval: '5m',
    repeat_interval: '4h',
    // `continue` stays unset (false): Grafana omits a false one when the tree is read back.
  };
}

/**
 * The tree a fresh stack ends with: `mergePolicy` of a default root. The root's receiver is OnCall, so
 * nothing falls back to the stack's default email contact point.
 */
export function notificationPolicy(): Route {
  return { receiver: CONTACT_POINT_NAME, group_by: ['grafana_folder', 'alertname'], routes: [ownedRoute()] };
}

/**
 * Whether a top-level route is this code's: its object_matchers are exactly `team=getworkdone` and it
 * has no legacy matchers. A route that also matches another label, like any other route, is foreign.
 */
export function isOwnedRoute(route: Route): boolean {
  const legacy = route as Route & { matchers?: unknown[]; match?: object; match_re?: object };
  const [first, ...rest] = route.object_matchers ?? [];
  return (
    first !== undefined &&
    rest.length === 0 &&
    first[0] === 'team' &&
    first[1] === '=' &&
    first[2] === TEAM &&
    (legacy.matchers ?? []).length === 0 &&
    Object.keys(legacy.match ?? {}).length === 0 &&
    Object.keys(legacy.match_re ?? {}).length === 0
  );
}

export interface MergedPolicy {
  tree: Route;
  /** Why the root receiver was left as it is, for apply.ts to report; absent when there is nothing to say. */
  rootNote?: string;
}

/**
 * The read-modify-write of a shared stack's policy tree (GWP#171). The stack is shared with other
 * tenants, and the provisioning API's PUT replaces the whole tree, so only the owned route changes:
 * - the owned route replaces the first owned route in place, and any later copy is dropped; when there is
 *   none it is appended, so another tenant's routes keep their order and their precedence;
 * - every other top-level route, every nested route and every root field pass through as read;
 * - the root receiver becomes OnCall only while it is the stack default (`grafana-default-email` or
 *   empty); any other receiver is left as is and `rootNote` says so, including OnCall itself while the
 *   tree holds other tenants' routes, because the root then catches their unmatched alerts too;
 * - `provenance`, which Grafana reports on a read, is not sent back.
 * Merging a merged tree returns it unchanged.
 */
export function mergePolicy(live: Route): MergedPolicy {
  const root: Route & { provenance?: unknown } = { ...live };
  delete root.provenance;
  const routes: Route[] = [];
  let placed = false;
  for (const route of live.routes ?? []) {
    if (!isOwnedRoute(route)) routes.push(route);
    else if (!placed) {
      routes.push(ownedRoute());
      placed = true;
    }
  }
  if (!placed) routes.push(ownedRoute());
  const current = live.receiver ?? '';
  const isDefault = DEFAULT_ROOT_RECEIVERS.includes(current);
  const shared = routes.some((route) => !isOwnedRoute(route));
  let rootNote: string | undefined;
  if (!isDefault && current !== CONTACT_POINT_NAME) rootNote = `receiver ${current} is not the stack default, left as is`;
  else if (current === CONTACT_POINT_NAME && shared) rootNote = `receiver ${current} is not the stack default, left as is; it also receives other tenants' alerts that no route matches`;
  return { tree: { ...root, receiver: isDefault ? CONTACT_POINT_NAME : current, routes }, ...(rootNote === undefined ? {} : { rootNote }) };
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
