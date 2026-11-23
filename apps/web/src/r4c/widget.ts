// The request-4-change widget's embed (GWP#10, docs/r4c.md; request-4-change-private
// docs/widget-contract/v1.md). /__r4c/ on the instance's hostname is routed to the edge sidecar, not the
// API, so the widget's script exists only behind the load balancer: it is added at run time, for a
// signed-in user on an instance whose GET /api/v1/me carries `r4c`, never as a static tag Vite would try
// to resolve. The widget gets its assertion from TOKEN_URL with the session cookie, and reports each
// submit with an event that bubbles to document.

export const WIDGET_SCRIPT_SRC = '/__r4c/widget.js';
export const TOKEN_URL = '/api/v1/r4c/token';

/** Appends `<script type="module" src="/__r4c/widget.js">` to the head once, however often it is called. */
export function loadWidgetScript(doc: Document = document): void {
  if (doc.querySelector('script[data-r4c-widget]')) return;
  const script = doc.createElement('script');
  script.type = 'module';
  script.src = WIDGET_SCRIPT_SRC;
  script.setAttribute('data-r4c-widget', '');
  doc.head.appendChild(script);
}

export type WidgetOutcome = { kind: 'submitted'; requestId: string } | { kind: 'error'; error: string; retryAfter?: number };

function detailOf(event: Event): Record<string, unknown> {
  const detail = (event as CustomEvent<unknown>).detail;
  return typeof detail === 'object' && detail !== null ? detail as Record<string, unknown> : {};
}

/** Calls `onOutcome` for each r4c-submitted and r4c-error event on `target`; returns the unsubscribe. */
export function watchWidgetOutcome(target: EventTarget, onOutcome: (outcome: WidgetOutcome) => void): () => void {
  const submitted = (event: Event) => {
    const { requestId } = detailOf(event);
    onOutcome(typeof requestId === 'string' && requestId ? { kind: 'submitted', requestId } : { kind: 'error', error: 'unknown' });
  };
  const failed = (event: Event) => {
    const { error, retryAfter } = detailOf(event);
    onOutcome({ kind: 'error', error: typeof error === 'string' && error ? error : 'unknown', ...(typeof retryAfter === 'number' ? { retryAfter } : {}) });
  };
  target.addEventListener('r4c-submitted', submitted);
  target.addEventListener('r4c-error', failed);
  return () => {
    target.removeEventListener('r4c-submitted', submitted);
    target.removeEventListener('r4c-error', failed);
  };
}

/** The line shown beside the widget. */
export function outcomeMessage(outcome: WidgetOutcome): string {
  if (outcome.kind === 'submitted') return `Request sent: ${outcome.requestId}`;
  return `Request not sent: ${outcome.error}${outcome.retryAfter !== undefined ? ` (retry after ${outcome.retryAfter} s)` : ''}`;
}
