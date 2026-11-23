import { useEffect, useState, type FormEvent } from 'react';
import { FORM_ERROR_KEY, validateCapture, type CaptureErrors, type CaptureField } from '@getworkdone/contracts';
import type { WriteResult } from '../api.js';
import { startExportWait, waitMessage } from './export-wait.js';
import { carryOver, initialValues, toCaptureInput, valuesFrom, type FormValues } from './form-values.js';

interface Props {
  fields: CaptureField[];
  /** Sends the validated data; absent in the builder's preview, which checks but never submits. */
  onSubmit?: (data: Record<string, unknown>) => Promise<WriteResult<unknown>>;
  /** Prefixes element ids, so the preview and a real form can share a page. */
  idPrefix?: string;
  /**
   * Keep the errors shown when the fields change. The builder's preview clears them as it is edited; the
   * capture page's fields change only when it reloads a newer version after a submit, whose errors are
   * the ones to show against it (GWP#21).
   */
  keepErrorsWhenFieldsChange?: boolean;
  /** Data the form starts from instead of empty inputs: an item's, in the item view's data edit (GWP#23). */
  initialData?: Record<string, unknown>;
  /** The submit button's words; `Submit` by default. */
  submitLabel?: string;
}

/**
 * A capture form rendered from a work type's fields (GWP#4). Submit checks the data with
 * validateCapture first and shows its messages per field without sending anything; the API checks the
 * same object again and its 422 messages are shown the same way. After a 429 (the items quota, GWP#50)
 * the submit button stays disabled for the Retry-After seconds, with the count shown.
 */
export function CaptureForm({ fields, onSubmit, idPrefix = 'capture', keepErrorsWhenFieldsChange = false, initialData, submitLabel = 'Submit' }: Props) {
  const [values, setValues] = useState<FormValues>(() => (initialData ? valuesFrom(fields, initialData) : initialValues(fields)));
  const [errors, setErrors] = useState<CaptureErrors>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'saved'>('idle');
  // A new object per 429, so a second refusal restarts the count; unmounting stops it (as ExportsPanel).
  const [hold, setHold] = useState<{ seconds: number } | undefined>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const fieldShape = fields.map((f) => `${f.key}:${f.type}`).join(',');

  // The fields change as the builder edits them: keep what was typed for keys that still exist.
  useEffect(() => {
    setValues((current) => carryOver(fields, current));
    if (!keepErrorsWhenFieldsChange) setErrors({});
  }, [fieldShape]); // keyed on the fields' keys and types, not the array's identity

  useEffect(() => hold && startExportWait(hold.seconds, (left) => {
    setSecondsLeft(left);
    if (left === 0) setHold(undefined);
  }), [hold]);

  const set = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
    setStatus('idle');
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const data = toCaptureInput(fields, values);
    const checked = validateCapture(fields, data);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    if (!onSubmit) return;
    setStatus('sending');
    const result = await onSubmit(data).catch((): WriteResult<unknown> => ({ ok: false, errors: { [FORM_ERROR_KEY]: ['Could not reach the server'] } }));
    if (result.ok) {
      setValues(initialValues(fields));
      setStatus('saved');
    } else {
      setErrors(result.errors);
      setStatus('idle');
      if (result.retryAfterSeconds !== undefined) setHold({ seconds: result.retryAfterSeconds });
    }
  }

  // Errors for keys that are not fields (an unknown key, the form as a whole) are listed above the fields.
  const formErrors = Object.entries(errors).filter(([key]) => !fields.some((f) => f.key === key))
    .flatMap(([key, messages]) => messages.map((m) => (key === FORM_ERROR_KEY ? m : `${key}: ${m}`)));

  return (
    <form noValidate onSubmit={(e) => void submit(e)} data-testid={`${idPrefix}-form`}>
      {formErrors.length > 0 && <ul role="alert" data-testid={`${idPrefix}-form-errors`}>{formErrors.map((m) => <li key={m}>{m}</li>)}</ul>}
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const fieldErrors = errors[field.key] ?? [];
        const describedBy = fieldErrors.length > 0 ? `${id}-error` : undefined;
        const common = { id, name: field.key, 'aria-invalid': fieldErrors.length > 0, 'aria-describedby': describedBy, 'aria-required': field.required };
        const value = values[field.key];
        return (
          <div key={field.key} className="capture-field">
            {field.type === 'boolean'
              ? (
                  <label htmlFor={id}>
                    <input {...common} type="checkbox" checked={value === true} onChange={(e) => set(field.key, e.target.checked)} /> {field.label}
                  </label>
                )
              : <label htmlFor={id}>{field.label}{field.required ? ' (required)' : ''}</label>}
            {field.type === 'longtext' && <textarea {...common} value={String(value ?? '')} onChange={(e) => set(field.key, e.target.value)} />}
            {field.type === 'select' && (
              <select {...common} value={String(value ?? '')} onChange={(e) => set(field.key, e.target.value)}>
                <option value="">Choose…</option>
                {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {['text', 'number', 'date', 'email', 'url'].includes(field.type) && (
              <input
                {...common}
                type={field.type === 'number' ? 'text' : field.type}
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                value={String(value ?? '')}
                onChange={(e) => set(field.key, e.target.value)}
              />
            )}
            {fieldErrors.length > 0 && (
              <ul id={`${id}-error`} className="field-errors" data-testid={`${id}-error`}>
                {fieldErrors.map((m) => <li key={m}>{m}</li>)}
              </ul>
            )}
          </div>
        );
      })}
      <button type="submit" disabled={status === 'sending' || hold !== undefined} data-testid={`${idPrefix}-submit`}>{onSubmit ? submitLabel : 'Check'}</button>
      {secondsLeft > 0 && <p data-testid={`${idPrefix}-wait`}>{waitMessage(secondsLeft, 'submit')}</p>}
      {status === 'saved' && <p role="status" data-testid={`${idPrefix}-saved`}>Saved.</p>}
    </form>
  );
}
