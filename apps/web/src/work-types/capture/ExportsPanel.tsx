import { useCallback, useEffect, useState } from 'react';
import type { ExportFormat, ExportResponse } from '@getworkdone/contracts';
import { createExport, exportDownloadPath, listExports } from '../api.js';
import { startExportWait, waitMessage } from './export-wait.js';

/**
 * Exports of a work type's completed items (GWP#6, docs/outputs.md), for a work type with an `export`
 * output: generate a CSV or JSON file now, and download any earlier one. Any team member may do both.
 * After a 429 the button stays disabled for the Retry-After seconds, with the count shown (GWP#35).
 */
export function ExportsPanel({ teamId, workTypeId, defaultFormat, csrfToken }: { teamId: string; workTypeId: string; defaultFormat: ExportFormat; csrfToken: string }) {
  const [exports, setExports] = useState<ExportResponse[] | 'error' | undefined>();
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  // A new object per 429, so a second refusal restarts the count; unmounting stops it.
  const [hold, setHold] = useState<{ seconds: number } | undefined>();
  const [secondsLeft, setSecondsLeft] = useState(0);

  const refresh = useCallback(() => {
    listExports(teamId, workTypeId).then(setExports).catch(() => setExports('error'));
  }, [teamId, workTypeId]);
  useEffect(refresh, [refresh]);
  useEffect(() => hold && startExportWait(hold.seconds, (left) => {
    setSecondsLeft(left);
    if (left === 0) {
      setHold(undefined);
      setMessage(undefined);
    }
  }), [hold]);

  async function generate() {
    setBusy(true);
    setMessage(undefined);
    const result = await createExport(teamId, workTypeId, format, csrfToken);
    setBusy(false);
    if (result.ok) refresh();
    else {
      setMessage(Object.values(result.errors).flat().join(' ') || 'The export failed');
      if (result.retryAfterSeconds !== undefined) setHold({ seconds: result.retryAfterSeconds });
    }
  }

  return (
    <section aria-labelledby="exports-title" data-testid="exports">
      <h3 id="exports-title">Exports</h3>
      <p>
        <label htmlFor="export-format">Format</label>{' '}
        <select id="export-format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>{' '}
        <button type="button" disabled={busy || hold !== undefined} onClick={() => void generate()} data-testid="export-generate">Export completed items</button>
      </p>
      {message && <p role="alert">{message}</p>}
      {secondsLeft > 0 && <p data-testid="export-wait">{waitMessage(secondsLeft)}</p>}
      {exports === 'error' && <p role="alert">Could not load the exports.</p>}
      {Array.isArray(exports) && exports.length > 0 && (
        <ul data-testid="export-list">
          {exports.map((e) => (
            <li key={e.id}>
              <a href={exportDownloadPath(teamId, e.id)} download>{e.format.toUpperCase()}, {e.itemCount} item{e.itemCount === 1 ? '' : 's'}, {new Date(e.createdAt).toLocaleString()}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
