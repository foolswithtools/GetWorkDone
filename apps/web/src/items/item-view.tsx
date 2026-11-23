import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FORM_ERROR_KEY, type ItemDetailResponse, type TeamRole } from '@getworkdone/contracts';
import type { WriteResult } from '../work-types/api.js';
import { CaptureForm } from '../work-types/capture/CaptureForm.js';
import { cancelItem, completeStep, editItemData, getItem, resumeItem, retryStep } from './api.js';
import { DeliveriesPanel } from './deliveries.js';
import { canCancel, canComplete, canEditData, canResume, canRetry, completionBody, decisionInput, eventSummary, stepStates, type CompletionForm } from './model.js';

interface Props {
  teamId: string;
  itemId: string;
  role: TeamRole;
  csrfToken: string;
  onBack: () => void;
}

/**
 * One item (GWP#5, docs/process.md): its status and data, the steps of the version it was captured
 * under with the current one marked, its deliveries (GWP#6) and its event history. A member holding the waiting step's role
 * completes it here; an admin retries a failed step, resumes an item whose processing stopped between
 * two transitions (GWP#22), or corrects the data of a failed or waiting item in the capture form, prefilled,
 * before a retry or the step's completion (GWP#23). The person completing a human step records a decision
 * (one of the step's, or free text) and a comment; an admin cancels an item that has not completed, with
 * a reason, after confirming (GWP#54). Each action sends the rowVersion this view read,
 * so a stale view is refused (409) and reloaded rather than acting twice.
 */
export function ItemView({ teamId, itemId, role, csrfToken, onBack }: Props) {
  const [item, setItem] = useState<ItemDetailResponse | 'error' | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  // The completion form is the step's it was typed for: after a reload that moved the item on, another step starts blank.
  const [completion, setCompletion] = useState<CompletionForm & { stepId?: string }>({ decision: '', comment: '' });
  const formFor = (stepId: string): CompletionForm => (completion.stepId === stepId ? completion : { decision: '', comment: '' });
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    getItem(teamId, itemId).then(setItem).catch(() => setItem('error'));
  }, [teamId, itemId]);
  useEffect(load, [load]);

  async function act(action: () => Promise<WriteResult<ItemDetailResponse>>) {
    setBusy(true);
    setMessage(undefined);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      setItem(result.value);
      setCompletion({ decision: '', comment: '' });
      setCancelling(false);
      setReason('');
      return;
    }
    setMessage(Object.values(result.errors).flat().join(' ') || 'The item could not be changed');
    if (result.errors[FORM_ERROR_KEY]) load();
  }

  /**
   * The edit form's submit: on success the view shows the item it answers, whose rowVersion a retry then
   * sends. A refusal of the whole edit (a stale view, 409) closes the form, shows its message and reloads
   * the item, so the next edit starts from the data as it now is and never sends the old form's values
   * over someone else's change. Field errors (422) stay in the open form.
   */
  async function saveData(current: ItemDetailResponse, data: Record<string, unknown>): Promise<WriteResult<ItemDetailResponse>> {
    setMessage(undefined);
    const result = await editItemData(teamId, current.id, current.rowVersion, data, csrfToken);
    if (result.ok) {
      setItem(result.value);
      setEditing(false);
    } else if (result.errors[FORM_ERROR_KEY]) {
      setMessage(Object.values(result.errors).flat().join(' '));
      setEditing(false);
      load();
    }
    return result;
  }

  if (item === undefined) return <p>Loading the item…</p>;
  if (item === 'error') return <p role="alert">Could not load the item.</p>;

  const states = stepStates(item);
  return (
    <section aria-labelledby="item-title" data-testid="item-view">
      <h3 id="item-title">Item</h3>
      <p><button type="button" onClick={onBack}>Back to the items</button></p>
      <p>
        Status: <span data-testid="item-status">{item.status}</span>{' '}
        {canResume(item, role) && (
          <button type="button" disabled={busy || editing} onClick={() => void act(() => resumeItem(teamId, item.id, item.rowVersion, csrfToken))}>Resume</button>
        )}{' '}
        {canCancel(item, role) && !cancelling && (
          <button type="button" disabled={busy || editing} onClick={() => { setMessage(undefined); setCancelling(true); }}>Cancel item</button>
        )}
      </p>
      {canCancel(item, role) && cancelling && (
        <section aria-label="Cancel the item" data-testid="item-cancel">
          <p>Cancelling stops the item for good: no step runs and no output fires. Its data and history are kept.</p>
          <label htmlFor="cancel-reason">Reason (optional)</label>
          <textarea id="cancel-reason" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p>
            <button type="button" disabled={busy || editing} onClick={() => void act(() => cancelItem(teamId, item.id, item.rowVersion, reason.trim() === '' ? undefined : reason, csrfToken))}>Confirm cancel</button>{' '}
            <button type="button" disabled={busy} onClick={() => { setCancelling(false); setReason(''); }}>Keep the item</button>
          </p>
        </section>
      )}
      <dl data-testid="item-data">
        {Object.entries(item.data).map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
        ))}
      </dl>
      {canEditData(item, role) && (editing
        ? (
            <section aria-label="Edit data" data-testid="item-edit-data">
              <CaptureForm fields={item.fields} initialData={item.data} idPrefix="edit-data" submitLabel="Save data" onSubmit={(data) => saveData(item, data)} />
              <button type="button" onClick={() => setEditing(false)}>Cancel</button>
            </section>
          )
        : <p><button type="button" disabled={busy} onClick={() => { setMessage(undefined); setEditing(true); }}>Edit data</button></p>)}
      {message && <p role="alert" data-testid="item-message">{message}</p>}
      <h4>Steps</h4>
      {states.length === 0
        ? <p>This work type has no steps.</p>
        : (
            <ol>
              {states.map(({ step, state, label }, index) => (
                <li key={step.id} data-testid="item-step" data-state={state} aria-current={state === 'waiting' || state === 'running' || state === 'failed' ? 'step' : undefined}>
                  {step.name || step.id} ({step.kind}): {label}{' '}
                  {canComplete(item, index, role) && (
                    <CompletionFields step={step} form={formFor(step.id)} onChange={(form) => setCompletion({ ...form, stepId: step.id })} disabled={busy || editing}>
                      <button type="button" disabled={busy || editing} onClick={() => void act(() => completeStep(teamId, item.id, step.id, completionBody(item.rowVersion, formFor(step.id)), csrfToken))}>Complete {step.name || step.id}</button>
                    </CompletionFields>
                  )}
                  {canRetry(item, index, role) && (
                    <button type="button" disabled={busy || editing} onClick={() => void act(() => retryStep(teamId, item.id, step.id, item.rowVersion, csrfToken))}>Retry {step.name || step.id}</button>
                  )}
                </li>
              ))}
            </ol>
          )}
      <DeliveriesPanel teamId={teamId} itemId={item.id} version={item.rowVersion} />
      <h4>History</h4>
      <table data-testid="item-history">
        <thead>
          <tr><th scope="col">#</th><th scope="col">Event</th><th scope="col">Step</th><th scope="col">By</th><th scope="col">At</th></tr>
        </thead>
        <tbody>
          {item.events.map((event) => (
            <tr key={event.seq} data-testid="item-event">
              <td>{event.seq}</td>
              <td data-col="type">{event.type}</td>
              <td>{eventSummary(event, item.steps)}</td>
              <td>{event.actorSubject ?? 'automated'}</td>
              <td>{new Date(event.at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The decision and comment beside a human step's Complete button (GWP#54): a select of the step's
 * decisions when it lists them, else free text, and a comment box. Both go on the step_completed event.
 */
function CompletionFields({ step, form, onChange, disabled, children }: {
  step: ItemDetailResponse['steps'][number];
  form: CompletionForm;
  onChange: (next: CompletionForm) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const input = decisionInput(step);
  const id = (part: string) => `complete-${step.id}-${part}`;
  return (
    <span data-testid="item-completion">
      <label htmlFor={id('decision')}>Decision{input.kind === 'text' ? ' (optional)' : ''}</label>{' '}
      {input.kind === 'select'
        ? (
            <select id={id('decision')} value={form.decision} disabled={disabled} onChange={(e) => onChange({ ...form, decision: e.target.value })}>
              <option value="">Choose one</option>
              {input.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )
        : <input id={id('decision')} value={form.decision} maxLength={40} disabled={disabled} onChange={(e) => onChange({ ...form, decision: e.target.value })} />}{' '}
      <label htmlFor={id('comment')}>Comment (optional)</label>{' '}
      <textarea id={id('comment')} rows={1} maxLength={2000} value={form.comment} disabled={disabled} onChange={(e) => onChange({ ...form, comment: e.target.value })} />{' '}
      {children}
    </span>
  );
}
