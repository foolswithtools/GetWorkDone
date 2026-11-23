import { useEffect, useRef, useState } from 'react';
import { FieldType, FORM_ERROR_KEY, Slug, type CaptureErrors, type WorkTypeResponse } from '@getworkdone/contracts';
import { addVersion, createWorkType } from '../api.js';
import { CaptureForm } from '../capture/CaptureForm.js';
import { buildDefinition, defaultOutputs, definitionErrors, draftFromField, fieldFromDraft, moveField, newDraftField, removeField, updateField, type DraftField } from './model.js';
import { draftFromOutput, outputFromDraft, type DraftOutput } from './outputs/model.js';
import { OutputsEditor } from './outputs/OutputsEditor.js';
import { draftFromStep, stepFromDraft, type DraftStep } from './steps/model.js';
import { StepsEditor } from './steps/StepsEditor.js';

interface Props {
  teamId: string;
  csrfToken: string;
  /** The work type to change; absent for a new one. */
  workType?: WorkTypeResponse;
  onSaved: (workType: WorkTypeResponse) => void;
  onCancel: () => void;
}

type Setting = 'key' | 'label' | 'options' | 'min' | 'max' | 'pattern';

/**
 * The schema builder (GWP#4, D-028): add, edit, reorder and remove a work type's fields, with a live
 * preview of the capture form, its process steps in the step editor (GWP#5, steps/) and its outputs in
 * the output editor (GWP#6, outputs/). Saving a new work type creates it with version 1; saving an
 * existing one posts its next version (definitions are immutable).
 * Reordering is by the Move up and Move down buttons, so it works from the keyboard; focus stays on the
 * button pressed and the move is announced.
 */
export function Builder({ teamId, csrfToken, workType, onSaved, onCancel }: Props) {
  const stored = workType?.version.definition;
  const [slug, setSlug] = useState('');
  const [drafts, setDrafts] = useState<DraftField[]>(() => stored ? stored.fields.map(draftFromField) : [newDraftField([])]);
  const [stepDrafts, setStepDrafts] = useState<DraftStep[]>(() => (stored?.steps ?? []).map(draftFromStep));
  const [outputDrafts, setOutputDrafts] = useState<DraftOutput[]>(() => (stored?.outputs ?? defaultOutputs()).map(draftFromOutput));
  const [serverErrors, setServerErrors] = useState<CaptureErrors>({});
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const focusAfterMove = useRef<string | undefined>(undefined);

  const fields = drafts.map(fieldFromDraft);
  const definition = buildDefinition(drafts, stored, stepDrafts.map((step) => stepFromDraft(step, fields)), outputDrafts.map(outputFromDraft));
  const localErrors = definitionErrors(definition);
  const slugError = workType || Slug.safeParse(slug).success ? undefined : 'Use lower-case letters, digits and dashes, starting with a letter';
  // A server answer keys definition paths under `definition.`; the builder's own check does not.
  const errorsAt = (path: string) => [...(localErrors[path] ?? []), ...(serverErrors[path] ?? []), ...(serverErrors[`definition.${path}`] ?? [])];
  const formErrors = [...errorsAt('fields'), ...errorsAt(FORM_ERROR_KEY), ...Object.entries(serverErrors).filter(([k]) => !k.startsWith('definition.fields.') && !k.startsWith('definition.steps') && !k.startsWith('definition.outputs') && k !== FORM_ERROR_KEY && k !== 'slug').flatMap(([k, m]) => m.map((x) => `${k}: ${x}`))];
  const valid = Object.keys(localErrors).length === 0 && !slugError;

  useEffect(() => {
    if (focusAfterMove.current) document.getElementById(focusAfterMove.current)?.focus();
    focusAfterMove.current = undefined;
  }, [drafts]);

  // Any edit clears the server's answer: its errors are keyed by field position, which edits can change.
  const edit = (next: (current: DraftField[]) => DraftField[]) => {
    setDrafts(next);
    setServerErrors({});
  };
  const change = (index: number, patch: Partial<DraftField>) => edit((current) => updateField(current, index, patch));
  const editSteps = (next: (current: DraftStep[]) => DraftStep[]) => {
    setStepDrafts(next);
    setServerErrors({});
  };
  const editOutputs = (next: (current: DraftOutput[]) => DraftOutput[]) => {
    setOutputDrafts(next);
    setServerErrors({});
  };

  const move = (index: number, delta: -1 | 1) => {
    const draft = drafts[index];
    if (!draft) return;
    const target = index + delta;
    // Focus follows the moved field's button; at either end that button is disabled, so the other one.
    const atEnd = delta < 0 ? target === 0 : target === drafts.length - 1;
    focusAfterMove.current = `builder-${draft.id}-${(delta < 0) !== atEnd ? 'up' : 'down'}`;
    edit((current) => moveField(current, index, delta));
    setAnnouncement(`Moved ${draft.label || draft.key} to position ${target + 1} of ${drafts.length}`);
  };

  async function save() {
    if (!valid) return;
    setSaving(true);
    const result = workType
      ? await addVersion(teamId, workType.id, definition, csrfToken)
      : await createWorkType(teamId, slug, definition, csrfToken);
    setSaving(false);
    if (result.ok) onSaved(result.value);
    else setServerErrors(result.errors);
  }

  return (
    <section aria-labelledby="builder-title">
      <h3 id="builder-title">{workType ? `Edit ${workType.slug} (next version: ${workType.version.version + 1})` : 'New work type'}</h3>
      <p aria-live="polite" className="visually-hidden" data-testid="builder-announcement">{announcement}</p>
      {!workType && (
        <p>
          <label htmlFor="builder-slug">Slug</label>
          <input id="builder-slug" value={slug} onChange={(e) => {
            setSlug(e.target.value);
            setServerErrors({});
          }} aria-invalid={!!slugError && slug !== ''} aria-describedby="builder-slug-error" />
          {(slug !== '' && slugError) || serverErrors.slug ? <span id="builder-slug-error" data-testid="builder-slug-error">{slugError ?? serverErrors.slug?.join(' ')}</span> : null}
        </p>
      )}
      {formErrors.length > 0 && <ul role="alert" data-testid="builder-errors">{formErrors.map((m) => <li key={m}>{m}</li>)}</ul>}
      <ol data-testid="builder-fields">
        {drafts.map((draft, index) => {
          const id = (setting: string) => `builder-${draft.id}-${setting}`;
          const errors = (setting: string) => errorsAt(`fields.${index}.${setting}`);
          const setting = (name: Setting, label: string, extra: { hint?: string; multiline?: boolean } = {}) => (
            <div>
              <label htmlFor={id(name)}>{label}</label>
              {extra.multiline
                ? <textarea id={id(name)} value={draft[name]} onChange={(e) => change(index, { [name]: e.target.value })} aria-describedby={`${id(name)}-error`} />
                : <input id={id(name)} value={draft[name]} onChange={(e) => change(index, { [name]: e.target.value })} aria-describedby={`${id(name)}-error`} placeholder={extra.hint} />}
              {errors(name).length > 0 && <span id={`${id(name)}-error`} role="alert" data-testid={`builder-field-${index}-${name}-error`}>{errors(name).join(' ')}</span>}
            </div>
          );
          const field = fieldFromDraft(draft);
          return (
            <li key={draft.id} data-testid="builder-field">
              <fieldset>
                <legend>Field {index + 1}: {draft.label || draft.key}</legend>
                {setting('label', 'Label')}
                {setting('key', 'Key')}
                <div>
                  <label htmlFor={id('type')}>Type</label>
                  <select id={id('type')} value={draft.type} onChange={(e) => change(index, { type: e.target.value as DraftField['type'] })}>
                    {FieldType.options.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={id('required')}>
                    <input id={id('required')} type="checkbox" checked={draft.required} onChange={(e) => change(index, { required: e.target.checked })} /> Required
                  </label>
                </div>
                {field.type === 'select' && setting('options', 'Options (one per line)', { multiline: true })}
                {['text', 'longtext', 'number'].includes(field.type) && setting('min', field.type === 'number' ? 'Minimum' : 'Minimum length')}
                {['text', 'longtext', 'number'].includes(field.type) && setting('max', field.type === 'number' ? 'Maximum' : 'Maximum length')}
                {['text', 'longtext'].includes(field.type) && setting('pattern', 'Pattern (regular expression the whole value must match)')}
                <div role="group" aria-label={`Arrange field ${index + 1}`}>
                  <button type="button" id={id('up')} onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${draft.label || draft.key} up`}>Move up</button>
                  <button type="button" id={id('down')} onClick={() => move(index, 1)} disabled={index === drafts.length - 1} aria-label={`Move ${draft.label || draft.key} down`}>Move down</button>
                  <button type="button" onClick={() => edit((current) => removeField(current, index))} aria-label={`Remove ${draft.label || draft.key}`}>Remove</button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <p>
        <button type="button" data-testid="builder-add" onClick={() => edit((current) => [...current, newDraftField(current)])}>Add field</button>
      </p>
      <StepsEditor steps={stepDrafts} fields={fields} errorsAt={errorsAt} onChange={editSteps} announce={setAnnouncement} />
      <OutputsEditor outputs={outputDrafts} errorsAt={errorsAt} onChange={editOutputs} />
      <p>
        <button type="button" data-testid="builder-save" onClick={() => void save()} disabled={!valid || saving}>{workType ? 'Save new version' : 'Create work type'}</button>{' '}
        <button type="button" onClick={onCancel}>Cancel</button>
      </p>
      <h4>Preview</h4>
      {/* The preview needs valid fields only; a step or output still being set up does not hide it. */}
      {Object.keys(localErrors).every((path) => path.startsWith('steps') || path.startsWith('outputs'))
        ? <CaptureForm fields={definition.fields} idPrefix="preview" />
        : <p data-testid="preview-unavailable">Fix the errors above to see the form.</p>}
    </section>
  );
}
