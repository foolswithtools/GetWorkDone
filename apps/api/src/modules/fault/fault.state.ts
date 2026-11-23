// The drill route's fault (GWP#9), held in memory per task: the dev service runs one task (#8), so a
// fault set through one request applies to every later drill request. A fault expires 60 minutes after
// it was set, so a drill that dies part way never leaves dev failing.

import { Inject, Injectable } from '@nestjs/common';

export const FAULT_OPTIONS = Symbol('FAULT_OPTIONS');

export interface FaultOptions {
  /** FAULT_INJECTION_ENABLED=true: mount the drill and fault routes. Only the dev task definition sets it. */
  enabled: boolean;
  /** FAULT_ADMIN_SUBJECTS: the subjects that may set a fault. */
  adminSubjects: ReadonlySet<string>;
  /** The clock, for tests. */
  now?: () => Date;
}

export type FaultMode = 'errors' | 'latency' | 'off';

/** The latency fault's wait: above the latency SLO's 0.8 s boundary (observability/slo/definitions.ts). */
export const LATENCY_FAULT_MS = 1_200;
export const FAULT_TTL_MS = 60 * 60_000;
export const DEFAULT_ERROR_COUNT = 500;
export const MAX_ERROR_COUNT = 5_000;

export interface FaultStatus {
  mode: FaultMode;
  /** errors: drill requests still to fail. */
  remaining?: number;
  /** When the fault lapses, if one is set. */
  expiresAt?: string;
}

@Injectable()
export class FaultState {
  private mode: FaultMode = 'off';
  private remaining = 0;
  private setAt = 0;

  constructor(@Inject(FAULT_OPTIONS) private readonly options: FaultOptions) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  set(mode: FaultMode, count = DEFAULT_ERROR_COUNT): FaultStatus {
    this.mode = mode;
    this.remaining = mode === 'errors' ? count : 0;
    this.setAt = this.now();
    return this.status();
  }

  /** The fault in force now: off once it has expired or run out of errors. */
  current(): FaultMode {
    if (this.mode !== 'off' && this.now() - this.setAt >= FAULT_TTL_MS) this.mode = 'off';
    if (this.mode === 'errors' && this.remaining <= 0) this.mode = 'off';
    return this.mode;
  }

  /** Spend one injected error; true when this drill request must fail. */
  takeError(): boolean {
    if (this.current() !== 'errors') return false;
    this.remaining--;
    return true;
  }

  status(): FaultStatus {
    const mode = this.current();
    if (mode === 'off') return { mode };
    return { mode, ...(mode === 'errors' ? { remaining: this.remaining } : {}), expiresAt: new Date(this.setAt + FAULT_TTL_MS).toISOString() };
  }
}
