import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startExportWait, waitMessage } from './export-wait.js';

// GWP#35: after a 429 the exports panel holds its button for the Retry-After seconds.
describe('startExportWait', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('counts the seconds left down from Retry-After to 0, once a second, then stops', () => {
    const ticks: number[] = [];
    startExportWait(20, (left) => ticks.push(left));
    expect(ticks).toEqual([20]);
    vi.advanceTimersByTime(19_000);
    expect(ticks.at(-1)).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(ticks).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    vi.advanceTimersByTime(5_000);
    expect(ticks).toHaveLength(21);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts from the clock, so a late tick (a throttled background tab) skips to the true seconds left', () => {
    const ticks: number[] = [];
    startExportWait(20, (left) => ticks.push(left));
    vi.setSystemTime(Date.now() + 12_000);
    vi.advanceTimersByTime(1_000);
    expect(ticks).toEqual([20, 7]);
  });

  it('stops without another tick when cancelled, as when the panel unmounts', () => {
    const ticks: number[] = [];
    const cancel = startExportWait(20, (left) => ticks.push(left));
    vi.advanceTimersByTime(3_000);
    cancel();
    vi.advanceTimersByTime(30_000);
    expect(ticks).toEqual([20, 19, 18, 17]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends at once for no wait at all', () => {
    const ticks: number[] = [];
    startExportWait(0, (left) => ticks.push(left));
    expect(ticks).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('waitMessage', () => {
  it('says how many seconds are left before the next export', () => {
    expect(waitMessage(20)).toBe('You can export again in 20 seconds.');
    expect(waitMessage(1)).toBe('You can export again in 1 second.');
  });

  it('names what the form holds: submit for the capture form, create a team for the team form (GWP#50)', () => {
    expect(waitMessage(12, 'submit')).toBe('You can submit again in 12 seconds.');
    expect(waitMessage(1, 'submit')).toBe('You can submit again in 1 second.');
    expect(waitMessage(3600, 'create a team')).toBe('You can create a team again in 3600 seconds.');
  });
});
