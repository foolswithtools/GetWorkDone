import { useEffect, useState } from 'react';
import type { DeliveryResponse } from '@getworkdone/contracts';
import { getDeliveries } from './api.js';

/**
 * The item view's deliveries panel (GWP#6, docs/outputs.md): each email and webhook output's delivery of
 * this item, with its status, attempts, last error and when it is next tried. `version` is the item's
 * rowVersion, so the panel reloads when the item moves (a completion writes the rows).
 */
export function DeliveriesPanel({ teamId, itemId, version }: { teamId: string; itemId: string; version: number }) {
  const [deliveries, setDeliveries] = useState<DeliveryResponse[] | 'error' | undefined>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    getDeliveries(teamId, itemId).then(setDeliveries).catch(() => setDeliveries('error'));
  }, [teamId, itemId, version, reload]);

  return (
    <section aria-labelledby="deliveries-title" data-testid="item-deliveries">
      <h4 id="deliveries-title">Deliveries</h4>
      {deliveries === undefined && <p>Loading the deliveries…</p>}
      {deliveries === 'error' && <p role="alert">Could not load the deliveries.</p>}
      {Array.isArray(deliveries) && (deliveries.length === 0
        ? <p data-testid="no-deliveries">Nothing to deliver: this item has no email or webhook output, or it has not completed.</p>
        : (
            <table>
              <thead>
                <tr><th scope="col">Output</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last error</th><th scope="col">When</th></tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} data-testid="item-delivery" data-status={d.status}>
                    <td>{d.outputId}</td>
                    <td>{d.kind}</td>
                    <td data-col="status">{d.status}</td>
                    <td>{d.attempts}</td>
                    <td data-col="error">{d.lastError ?? ''}</td>
                    <td>{d.status === 'delivered' && d.deliveredAt ? `delivered ${new Date(d.deliveredAt).toLocaleString()}` : d.status === 'pending' ? `next try ${new Date(d.nextAttemptAt).toLocaleString()}` : `gave up ${new Date(d.updatedAt).toLocaleString()}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      <p><button type="button" onClick={() => setReload((n) => n + 1)}>Refresh deliveries</button></p>
    </section>
  );
}
