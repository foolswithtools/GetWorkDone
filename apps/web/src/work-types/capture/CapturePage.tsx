import { useCallback, useEffect, useRef, useState } from 'react';
import { ExportConfig, ItemStatus, type ItemResponse, type WorkTypeResponse } from '@getworkdone/contracts';
import { browserNavigator } from '../../routing.js';
import { getWorkType, listItems, submitItem } from '../api.js';
import { CaptureForm } from './CaptureForm.js';
import { ExportsPanel } from './ExportsPanel.js';
import { namesUnknownKeys, olderKeys } from './item-list.js';

const display = (value: unknown) => (value === undefined ? '' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

/**
 * Capture an item of a work type (its latest version; not while it is archived, GWP#55) and see the items captured so far, newest first,
 * a page at a time (GWP#21), all of them or those in one status (GWP#54); open one at its own address to follow it through its steps (GWP#5, GWP#98, items/item-view.tsx); export
 * the completed ones when the work type has an export output (GWP#6).
 */
export function CapturePage({ teamId, workType: loaded, csrfToken, onReloaded, onOpenItem }: {
  teamId: string;
  workType: WorkTypeResponse;
  csrfToken: string;
  /** Called after the page reloads a newer version of the work type, so the team's list can follow. */
  onReloaded?: () => void;
  /** Opens one of the listed items (its own route, GWP#98). */
  onOpenItem: (itemId: string) => void;
}) {
  // The version the form validates against; replaced when the API turns out to know a newer one (GWP#21).
  const [workType, setWorkType] = useState(loaded);
  const [changed, setChanged] = useState(false);
  const [items, setItems] = useState<ItemResponse[] | 'error' | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // GWP#54: one status, or every item; a change reloads the first page, and Load more keeps it. GWP#98: kept
  // in this page's history entry, so it is still set on the way back from an item, and after a reload.
  const nav = browserNavigator();
  const [status, setStatusState] = useState<ItemStatus | undefined>(() => ItemStatus.safeParse(nav.entryValue('status')).data);
  const setStatus = (next: ItemStatus | undefined) => {
    nav.setEntryValue('status', next);
    setStatusState(next);
  };
  const { fields, outputs } = workType.version.definition;
  const exportOutput = outputs.find((o) => o.kind === 'export');

  // Each first-page load starts a new list; a Load more begun on an earlier list is dropped when it lands,
  // so a submit's refresh is never overwritten by an older page.
  const listGeneration = useRef(0);
  const refresh = useCallback(() => {
    const generation = ++listGeneration.current;
    setNextCursor(null); // the old list's cursor would skip an item the fresh first page pushed down
    listItems(teamId, workType.id, { status }).then((page) => {
      if (generation !== listGeneration.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (generation === listGeneration.current) setItems('error');
    });
  }, [teamId, workType.id, status]);
  useEffect(refresh, [refresh]);

  const loadMore = () => {
    if (nextCursor === null) return;
    const generation = listGeneration.current;
    setLoadingMore(true);
    listItems(teamId, workType.id, { cursor: nextCursor, status }).then((page) => {
      if (generation !== listGeneration.current) return;
      setItems((current) => (Array.isArray(current) ? [...current, ...page.items] : current));
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (generation === listGeneration.current) setItems('error');
    }).finally(() => setLoadingMore(false));
  };

  // Keys in listed items that the current fields lack: items captured under older versions.
  const older = Array.isArray(items) ? olderKeys(fields, items) : [];

  return (
    <section>
      {workType.archivedAt !== null
        ? <p role="status" data-testid="capture-archived">{workType.slug} is archived: it takes no new items. Its items below stay readable.</p>
        : (
            <>
              <h3>New {workType.slug}</h3>
              {changed && <p role="status" data-testid="capture-version-changed">This work type has changed: the form now shows version {workType.version.version}. Check the fields and submit again.</p>}
              <CaptureForm
                fields={fields}
                keepErrorsWhenFieldsChange
                onSubmit={async (data) => {
                  const result = await submitItem(teamId, workType.id, data, csrfToken);
                  if (result.ok) refresh();
                  else if (namesUnknownKeys(fields, result.errors)) {
                    // The API validated against a newer version: show its fields before its errors.
                    const fresh = await getWorkType(teamId, workType.id).catch(() => undefined);
                    if (fresh && fresh.version.id !== workType.version.id) {
                      setWorkType(fresh);
                      setChanged(true);
                      onReloaded?.();
                    }
                  }
                  return result;
                }}
              />
            </>
          )}
      <h3>Items</h3>
      <p>
        <label htmlFor="item-status-filter">Status</label>{' '}
        <select id="item-status-filter" data-testid="item-status-filter" value={status ?? ''} onChange={(e) => setStatus(e.target.value === '' ? undefined : ItemStatus.parse(e.target.value))}>
          <option value="">All</option>
          {ItemStatus.options.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </p>
      {items === undefined && <p>Loading items…</p>}
      {items === 'error' && <p role="alert">Could not load the items.</p>}
      {Array.isArray(items) && (items.length === 0
        ? <p data-testid="no-items">{status ? `No ${status} items.` : 'No items yet.'}</p>
        : (
            <>
              <table data-testid="item-list">
                <thead>
                  <tr>
                    <th scope="col">Captured</th>
                    <th scope="col">Status</th>
                    {fields.map((f) => <th key={f.key} scope="col">{f.label}</th>)}
                    {older.map((key) => <th key={`older-${key}`} scope="col" title="A field of an earlier version"><code>{key}</code></th>)}
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} data-testid="item-row">
                      <td>{new Date(item.createdAt).toLocaleString()}</td>
                      <td>{item.status}</td>
                      {fields.map((f) => <td key={f.key}>{display(item.data[f.key])}</td>)}
                      {older.map((key) => <td key={`older-${key}`}>{display(item.data[key])}</td>)}
                      <td><button type="button" onClick={() => onOpenItem(item.id)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {nextCursor !== null && <p><button type="button" onClick={loadMore} disabled={loadingMore} data-testid="load-more-items">Load more</button></p>}
            </>
          ))}
      {exportOutput && <ExportsPanel teamId={teamId} workTypeId={workType.id} defaultFormat={ExportConfig.safeParse(exportOutput.config).data?.format ?? 'csv'} csrfToken={csrfToken} />}
    </section>
  );
}
