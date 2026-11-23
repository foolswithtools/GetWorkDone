import { useEffect, useState } from 'react';
import { loadWidgetScript, outcomeMessage, TOKEN_URL, watchWidgetOutcome, type WidgetOutcome } from './widget.js';

// The element the widget's script defines (request-4-change-private docs/widget-contract/v1.md, "Embed").
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'r4c-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { 'app-id'?: string; 'token-url'?: string };
    }
  }
}

/**
 * The request-4-change widget (GWP#10, docs/r4c.md), for a signed-in user on an instance whose
 * GET /api/v1/me carries `r4c`. The script is added once; the outcome of the last submit, the request
 * id or the error code, is shown beside the widget.
 */
export function R4cWidget({ appId }: { appId: string }) {
  const [outcome, setOutcome] = useState<WidgetOutcome | undefined>();
  useEffect(() => {
    loadWidgetScript();
    return watchWidgetOutcome(document, setOutcome);
  }, []);
  return (
    <section aria-labelledby="r4c-title" data-testid="r4c">
      <h2 id="r4c-title">Request a change to GetWorkDone</h2>
      <r4c-widget app-id={appId} token-url={TOKEN_URL} />
      <p role="status" data-testid="r4c-outcome">{outcome && outcomeMessage(outcome)}</p>
    </section>
  );
}
