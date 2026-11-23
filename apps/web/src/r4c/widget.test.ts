import { describe, expect, it } from 'vitest';
import { loadWidgetScript, outcomeMessage, TOKEN_URL, WIDGET_SCRIPT_SRC, watchWidgetOutcome, type WidgetOutcome } from './widget.js';

// The request-4-change widget's embed (GWP#10, docs/r4c.md): the module script is added once, at run
// time, and the widget's events (widget contract v1, "Events") are shown beside it.

interface FakeScript { tagName: string; attributes: Map<string, string>; type: string; src: string; setAttribute(name: string, value: string): void; getAttribute(name: string): string | null }

/** Just enough of Document for the loader: createElement, head.appendChild and querySelector. */
function fakeDocument() {
  const appended: FakeScript[] = [];
  const doc = {
    createElement(tagName: string): FakeScript {
      const attributes = new Map<string, string>();
      return {
        tagName: tagName.toUpperCase(), attributes, type: '', src: '',
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
      };
    },
    head: { appendChild: (el: FakeScript) => (appended.push(el), el) },
    querySelector: (selector: string) => (selector === 'script[data-r4c-widget]' ? appended.find((el) => el.attributes.has('data-r4c-widget')) ?? null : null),
  };
  return { doc: doc as unknown as Document, appended };
}

describe('loadWidgetScript', () => {
  it('appends one module script for /__r4c/widget.js to the head, however often it is called', () => {
    const { doc, appended } = fakeDocument();
    for (let i = 0; i < 3; i++) loadWidgetScript(doc);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ tagName: 'SCRIPT', type: 'module', src: WIDGET_SCRIPT_SRC });
    expect(WIDGET_SCRIPT_SRC).toBe('/__r4c/widget.js');
  });

  it('the token-url is the API\'s same-origin token route', () => {
    expect(TOKEN_URL).toBe('/api/v1/r4c/token');
  });
});

describe('watchWidgetOutcome', () => {
  function watch() {
    const target = new EventTarget();
    const seen: WidgetOutcome[] = [];
    const stop = watchWidgetOutcome(target, (o) => seen.push(o));
    return { target, seen, stop };
  }

  it('reflects r4c-submitted as the request id', () => {
    const { target, seen } = watch();
    target.dispatchEvent(new CustomEvent('r4c-submitted', { detail: { requestId: '6f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f' } }));
    expect(seen).toEqual([{ kind: 'submitted', requestId: '6f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f' }]);
    expect(outcomeMessage(seen[0]!)).toBe('Request sent: 6f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f');
  });

  it('reflects r4c-error as its code, with Retry-After when given', () => {
    const { target, seen } = watch();
    target.dispatchEvent(new CustomEvent('r4c-error', { detail: { error: 'invalid_assertion' } }));
    target.dispatchEvent(new CustomEvent('r4c-error', { detail: { error: 'rate_limited', retryAfter: 30 } }));
    expect(seen).toEqual([{ kind: 'error', error: 'invalid_assertion' }, { kind: 'error', error: 'rate_limited', retryAfter: 30 }]);
    expect(outcomeMessage(seen[0]!)).toBe('Request not sent: invalid_assertion');
    expect(outcomeMessage(seen[1]!)).toBe('Request not sent: rate_limited (retry after 30 s)');
  });

  it('a malformed detail is shown as an unknown error, never thrown', () => {
    const { target, seen } = watch();
    target.dispatchEvent(new CustomEvent('r4c-submitted', { detail: null }));
    target.dispatchEvent(new CustomEvent('r4c-error', { detail: { error: 42, retryAfter: 'soon' } }));
    target.dispatchEvent(new Event('r4c-error'));
    expect(seen).toEqual([{ kind: 'error', error: 'unknown' }, { kind: 'error', error: 'unknown' }, { kind: 'error', error: 'unknown' }]);
  });

  it('stops listening when the returned function is called', () => {
    const { target, seen, stop } = watch();
    stop();
    target.dispatchEvent(new CustomEvent('r4c-submitted', { detail: { requestId: 'x' } }));
    expect(seen).toEqual([]);
  });
});
