// Create or update one object, then read it back (GET after write, exemplar observability/slo/apply.ts:5
// @ 12a071e) and fail when the stack does not hold what was sent. An object that already matches is
// left alone, so a second run makes no writes.

import type { Json } from './grafana-client.js';

export type Action = 'created' | 'updated' | 'unchanged';

export class Mismatch extends Error {}

/** A failure apply.ts reports as is and exits 1 on: a precondition the stack does not meet. */
export class ApplyError extends Error {}

export interface ReconcileSpec<A> {
  kind: string;
  name: string;
  /** What the stack must hold: every field here must equal the read-back, extra fields are ignored. */
  desired: unknown;
  read: () => Promise<A | undefined>;
  /** The part of what was read that `desired` is compared with; the whole object by default. */
  view?: (actual: A) => unknown;
  create: () => Promise<unknown>;
  update: (actual: A) => Promise<unknown>;
}

export interface Reconciled<A> {
  action: Action;
  actual: A;
}

export type Report = (line: string) => void;

export async function reconcile<A>(spec: ReconcileSpec<A>, report: Report): Promise<Reconciled<A>> {
  const view = spec.view ?? ((a: A) => a);
  const label = `${spec.kind} ${spec.name}`;
  const before = await spec.read();
  let action: Action;
  if (before === undefined) {
    await spec.create();
    action = 'created';
  } else if (differences(spec.desired, view(before)).length > 0) {
    await spec.update(before);
    action = 'updated';
  } else {
    report(`unchanged ${label}`);
    return { action: 'unchanged', actual: before };
  }
  const after = await spec.read();
  if (after === undefined) throw new Mismatch(`${label}: not found when read back after it was ${action}`);
  const diff = differences(spec.desired, view(after));
  if (diff.length > 0) throw new Mismatch(`${label}: read back differs at ${diff.join(', ')}`);
  report(`${action} ${label}`);
  return { action, actual: after };
}

/**
 * The paths at which `actual` does not hold `desired`. Objects are compared on the keys `desired`
 * names; arrays element by element and by length; anything else with ===.
 */
export function differences(desired: unknown, actual: unknown, path = ''): string[] {
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length !== desired.length) return [path || '(root)'];
    return desired.flatMap((item, index) => differences(item, actual[index], `${path}[${index}]`));
  }
  if (desired !== null && typeof desired === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [path || '(root)'];
    return Object.entries(desired as Json).flatMap(([key, value]) =>
      value === undefined ? [] : differences(value, (actual as Json)[key], path ? `${path}.${key}` : key),
    );
  }
  return desired === actual ? [] : [path || '(root)'];
}
