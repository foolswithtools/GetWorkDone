// Shared by the RED interceptor and the final status filter: one place for the request start time,
// the exactly-once claim, the synthetic flag and the route label, so both paths label a request the same way.

import type { Request } from 'express';
import { SPA_ROUTE, isReservedPath } from '../spa/spa.controller.js';
import { identityOf } from './identity.js';

const START = Symbol('red.start');
const RECORDED = Symbol('red.recorded');
const SYNTHETIC = Symbol('red.synthetic-subjects');

type Timed = Request & { [START]?: number; [RECORDED]?: true; [SYNTHETIC]?: ReadonlySet<string> };

/** Stamp the request's start; the first stamp wins (app.ts stamps before any route). */
export function markRequestStart(req: Request): void {
  const timed = req as Timed;
  timed[START] ??= performance.now();
}

/** Seconds since markRequestStart, or 0 when the request was never stamped. */
export function secondsSinceStart(req: Request): number {
  const start = (req as Timed)[START];
  return start === undefined ? 0 : (performance.now() - start) / 1000;
}

/**
 * True the first time it is called for a request, false after. The interceptor and the filter both
 * claim before recording, so a request is recorded once even when a handler returned and then its
 * response failed (the filter records the 500, the interceptor's finish listener skips).
 */
export function claimRecording(req: Request): boolean {
  const timed = req as Timed;
  if (timed[RECORDED]) return false;
  timed[RECORDED] = true;
  return true;
}

/**
 * Stamp the subjects whose traffic is synthetic (SYNTHETIC_SUBJECTS, read once by createApp) on the
 * request. app.ts stamps every request before any route.
 */
export function markSyntheticSubjects(req: Request, subjects: ReadonlySet<string>): void {
  (req as Timed)[SYNTHETIC] = subjects;
}

/**
 * True when the request is probe traffic: it carries a verified identity (the deny-by-default guard sets
 * it before any route) whose subject is in SYNTHETIC_SUBJECTS, such as the k6 smoke's user (GWP#9). The
 * SLOs select synthetic="false", so probes never spend the error budget. No header can make a request
 * synthetic, and an anonymous request never is.
 */
export function isSynthetic(req: Request): boolean {
  const subject = identityOf(req)?.subject;
  return subject !== undefined && ((req as Timed)[SYNTHETIC]?.has(subject) ?? false);
}

/**
 * The matched route pattern, never the raw URL: `spa` for the SPA fallback, `unmatched` when no
 * route matched (including /api/ and /__r4c/ paths the fallback refuses).
 */
export function routeLabel(req: Request): string {
  const path = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof path !== 'string') return 'unmatched';
  if (path === SPA_ROUTE) return isReservedPath(req.path) ? 'unmatched' : 'spa';
  return path;
}
