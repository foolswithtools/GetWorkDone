import { afterEach, describe, expect, it, vi } from 'vitest';
import { deadline } from '../src/modules/distribute/deadline.js';

// An attempt's deadline (GWP#6). Regression: AbortSignal.any with AbortSignal.timeout never aborted on
// Node 20, the runtime until the move to 24, so a webhook that answered after 15 s was recorded delivered
// despite its 10 s deadline.
describe('deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('aborts with a TimeoutError once the time has passed, and not before', () => {
    vi.useFakeTimers();
    const { signal } = deadline(10_000);
    vi.advanceTimersByTime(9_999);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });

  it('aborts as soon as the parent does, or at once when it already has', () => {
    const parent = new AbortController();
    const { signal } = deadline(10_000, parent.signal);
    parent.abort('stop');
    expect([signal.aborted, signal.reason]).toEqual([true, 'stop']);
    expect(deadline(10_000, parent.signal).signal.aborted).toBe(true);
  });

  it('clear stops the timer and the parent listener', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const { signal, clear } = deadline(10, parent.signal);
    clear();
    vi.advanceTimersByTime(20);
    parent.abort();
    expect(signal.aborted).toBe(false);
  });
});
