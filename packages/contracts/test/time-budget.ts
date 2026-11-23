import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** True when the run collects V8 coverage; set by time-budget.setup.ts in the unit config. */
    v8Coverage: boolean;
  }
}

// A timing assertion's budget in ms, for the few whose work V8 coverage slows past the plain budget.
// `pnpm test:unit` collects V8 coverage (vitest.config.ts), and on Node 22 and 24 precise coverage slows
// the matcher's hot loops about fivefold, against about 1.5x on Node 20 (GWP#46;
// docs/known-issues/2026-10-29-coverage-slows-timing-tests-on-node-24.md). The budget scales by
// COVERAGE_FACTOR only while coverage is on; a run without it keeps the plain budget. Use it only where a
// regression costs seconds, so the scaled budget still catches it.
export const COVERAGE_FACTOR = 5;

export function budget(ms: number): number {
  return inject('v8Coverage') ? ms * COVERAGE_FACTOR : ms;
}
