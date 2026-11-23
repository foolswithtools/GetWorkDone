// The exports panel's hold after a 429 (GWP#35, docs/outputs.md): the export route refuses a work
// type's export within 30 seconds of its last one and says in Retry-After how many seconds are left,
// so the panel keeps its button disabled for that long and shows the count. The capture form and the
// create-team form hold their buttons the same way after a quota's 429 (GWP#50, docs/domain.md).

/**
 * Calls `onTick` with the seconds left now and once a second after, ending with 0. The count comes
 * from the clock, so a late timer (a throttled background tab) skips ahead rather than falling behind.
 * Returns a function that stops the count without another tick.
 */
export function startExportWait(seconds: number, onTick: (secondsLeft: number) => void): () => void {
  const until = Date.now() + seconds * 1000;
  const left = () => Math.max(0, Math.ceil((until - Date.now()) / 1000));
  onTick(left());
  if (left() === 0) return () => {};
  const timer = setInterval(() => {
    const now = left();
    if (now === 0) clearInterval(timer);
    onTick(now);
  }, 1000);
  return () => clearInterval(timer);
}

/** The line shown while a button is held; `action` is what it does (`export`, `submit`, `create a team`). */
export function waitMessage(secondsLeft: number, action = 'export'): string {
  return `You can ${action} again in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}.`;
}
