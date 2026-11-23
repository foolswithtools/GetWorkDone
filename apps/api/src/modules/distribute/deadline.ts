// An attempt's deadline as an AbortSignal (GWP#6). Built from a plain AbortController and setTimeout, not
// AbortSignal.any with AbortSignal.timeout: on Node 20 (the runtime until the move to 24) a signal composed
// that way could lose its timeout and never abort, so an attempt ran past its deadline.

export interface Deadline {
  /** Aborts after `ms`, or as soon as `parent` aborts. */
  signal: AbortSignal;
  /** Clears the timer and the listener on `parent`; call when the attempt is over. */
  clear(): void;
}

export function deadline(ms: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`deadline of ${ms} ms passed`, 'TimeoutError')), ms);
  const onParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParent();
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}
