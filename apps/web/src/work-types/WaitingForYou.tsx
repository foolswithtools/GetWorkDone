import { useEffect, useRef, useState } from 'react';
import type { ItemResponse } from '@getworkdone/contracts';
import { listWaitingItems } from '../items/api.js';

const display = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

/** The first few captured values, so a row can be told apart without opening it. */
function summary(item: ItemResponse): string {
  return Object.values(item.data).filter((v) => v !== undefined && v !== null && v !== '').slice(0, 3).map(display).join(' · ');
}

/**
 * The items waiting for the signed-in member (GWP#55): `in_progress` at a human step whose role they hold,
 * across the team's work types, newest first, a page at a time, with the count. Each row opens the item
 * view; the list reloads whenever the team page's list view shows it again.
 */
export function WaitingForYou({ teamId, onOpen }: { teamId: string; onOpen: (itemId: string) => void }) {
  const [items, setItems] = useState<ItemResponse[] | 'error' | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A Load more begun before a reload is dropped when it lands.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    listWaitingItems(teamId).then((page) => {
      if (current !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (current === generation.current) setItems('error');
    });
  }, [teamId]);

  const loadMore = () => {
    if (nextCursor === null) return;
    const current = generation.current;
    setLoadingMore(true);
    listWaitingItems(teamId, { cursor: nextCursor }).then((page) => {
      if (current !== generation.current) return;
      setItems((loaded) => (Array.isArray(loaded) ? [...loaded, ...page.items] : loaded));
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (current === generation.current) setItems('error');
    }).finally(() => setLoadingMore(false));
  };

  return (
    <section aria-labelledby="waiting-title" data-testid="waiting-for-you">
      <h3 id="waiting-title">
        Waiting for you{Array.isArray(items) && <> (<span data-testid="waiting-count">{items.length}{nextCursor !== null ? '+' : ''}</span>)</>}
      </h3>
      {items === undefined && <p>Loading the items waiting for you…</p>}
      {items === 'error' && <p role="alert">Could not load the items waiting for you.</p>}
      {Array.isArray(items) && (items.length === 0
        ? <p data-testid="waiting-none">Nothing is waiting for you.</p>
        : (
            <>
              <table data-testid="waiting-list">
                <thead>
                  <tr>
                    <th scope="col">Captured</th>
                    <th scope="col">Item</th>
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} data-testid="waiting-row">
                      <td>{new Date(item.createdAt).toLocaleString()}</td>
                      <td>{summary(item)}</td>
                      <td><button type="button" onClick={() => onOpen(item.id)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {nextCursor !== null && <p><button type="button" onClick={loadMore} disabled={loadingMore} data-testid="load-more-waiting">Load more</button></p>}
            </>
          ))}
    </section>
  );
}
