import { useEffect, useRef } from 'react';
import { MAX_DECISION_LENGTH, MAX_DECISIONS, TeamRole, TRANSFORM_NAMES, TRANSFORM_TITLES, type CaptureField, type ParamSpec } from '@getworkdone/contracts';
import { changeTransform, fieldsFor, inputsFor, moveStep, newStep, removeStep, updateStep, type DraftStep } from './model.js';

interface Props {
  steps: DraftStep[];
  /** The fields as built so far: the ones a parameter may name. */
  fields: CaptureField[];
  /** The builder's errors at a definition path (`steps.0.params.field`), local and from the server. */
  errorsAt: (path: string) => string[];
  onChange: (next: (current: DraftStep[]) => DraftStep[]) => void;
  /** Announces a move to screen readers. */
  announce: (message: string) => void;
}

const stepLabel = (step: DraftStep, index: number) => step.name || `step ${index + 1}`;

/**
 * The builder's step editor (GWP#5, docs/process.md): add, reorder and remove human and automated
 * steps; array order is execution order. A human step may list its decisions, one per line (GWP#54),
 * which the person completing it chooses from. An automated step's parameter form is generated from its
 * transform's Zod params (describeParams). Reordering is by buttons, like the fields: focus stays on the
 * button pressed and the move is announced.
 */
export function StepsEditor({ steps, fields, errorsAt, onChange, announce }: Props) {
  const focusAfterMove = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (focusAfterMove.current) document.getElementById(focusAfterMove.current)?.focus();
    focusAfterMove.current = undefined;
  }, [steps]);

  const change = (index: number, patch: Partial<DraftStep>) => onChange((current) => updateStep(current, index, patch));
  // The contract's own bounds report at each decision (`steps.0.decisions.2`), stepProblems at the list.
  const decisionErrors = (index: number, step: DraftStep) => [
    ...errorsAt(`steps.${index}.decisions`),
    ...step.decisions.split('\n').filter((line) => line.trim() !== '').flatMap((_, k) => errorsAt(`steps.${index}.decisions.${k}`)),
  ];
  const move = (index: number, delta: -1 | 1) => {
    const step = steps[index];
    if (!step) return;
    const target = index + delta;
    const atEnd = delta < 0 ? target === 0 : target === steps.length - 1;
    focusAfterMove.current = `step-${step.draftId}-${(delta < 0) !== atEnd ? 'up' : 'down'}`;
    onChange((current) => moveStep(current, index, delta));
    announce(`Moved step ${stepLabel(step, index)} to position ${target + 1} of ${steps.length}`);
  };

  return (
    <section aria-labelledby="builder-steps-title" data-testid="builder-steps">
      <h4 id="builder-steps-title">Steps</h4>
      {steps.length === 0 && <p data-testid="no-steps">No steps: a captured item is completed straight away.</p>}
      <ol>
        {steps.map((step, index) => {
          const id = (part: string) => `step-${step.draftId}-${part}`;
          const errorList = (path: string, testId: string) => {
            const errors = errorsAt(`steps.${index}.${path}`);
            return errors.length > 0 ? <span id={`${id(path)}-error`} role="alert" data-testid={testId}>{errors.join(' ')}</span> : null;
          };
          const label = stepLabel(step, index);
          return (
            <li key={step.draftId} data-testid="builder-step">
              <fieldset>
                <legend>Step {index + 1}: {step.kind === 'human' ? 'human' : 'automated'}{step.name ? `, ${step.name}` : ''}</legend>
                <div>
                  <label htmlFor={id('name')}>Step name</label>
                  <input id={id('name')} value={step.name} onChange={(e) => change(index, { name: e.target.value })} />
                  {/* Ids are generated as step_N; a stored one from before the id rule may be refused. */}
                  {errorsAt(`steps.${index}.id`).length > 0 && <span role="alert" data-testid={`builder-step-${index}-id-error`}>Step id "{step.id}": {errorsAt(`steps.${index}.id`).join(' ')}. Remove this step and add it again.</span>}
                </div>
                {step.kind === 'human'
                  ? (
                      <>
                        <div>
                          <label htmlFor={id('role')}>Assignee role</label>
                          <select id={id('role')} value={step.assigneeRole} onChange={(e) => change(index, { assigneeRole: e.target.value as DraftStep['assigneeRole'] })}>
                            {TeamRole.options.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={id('decisions')}>Decisions (optional, one per line)</label>
                          <textarea id={id('decisions')} rows={3} value={step.decisions} onChange={(e) => change(index, { decisions: e.target.value })} aria-describedby={`${id('decisions')}-hint ${id('decisions')}-error`} />
                          <span id={`${id('decisions')}-hint`}>Up to {MAX_DECISIONS}, each up to {MAX_DECISION_LENGTH} characters; the person completing the step chooses one.</span>
                          {decisionErrors(index, step).length > 0 && <span id={`${id('decisions')}-error`} role="alert" data-testid={`builder-step-${index}-decisions-error`}>{decisionErrors(index, step).join(' ')}</span>}
                        </div>
                      </>
                    )
                  : (
                      <>
                        <div>
                          <label htmlFor={id('transform')}>Transform</label>
                          <select id={id('transform')} value={step.transform} onChange={(e) => onChange((current) => current.map((s, i) => (i === index ? changeTransform(s, e.target.value) : s)))} aria-describedby={`${id('transform')}-error`}>
                            {!TRANSFORM_NAMES.includes(step.transform as never) && <option value={step.transform}>{step.transform} (unknown)</option>}
                            {TRANSFORM_NAMES.map((t) => <option key={t} value={t}>{t}: {TRANSFORM_TITLES[t]}</option>)}
                          </select>
                          {errorList('transform', `builder-step-${index}-transform-error`)}
                        </div>
                        {errorList('params', `builder-step-${index}-params-error`)}
                        {inputsFor(step.transform).map((spec) => (
                          <ParamInput
                            key={spec.name}
                            spec={spec}
                            id={id(`param-${spec.name}`)}
                            step={step}
                            fields={fields}
                            errors={errorsAt(`steps.${index}.params.${spec.name}`)}
                            testId={`builder-step-${index}-param-${spec.name}-error`}
                            onInput={(value) => change(index, { inputs: { ...step.inputs, [spec.name]: value } })}
                          />
                        ))}
                      </>
                    )}
                <div role="group" aria-label={`Arrange step ${index + 1}`}>
                  <button type="button" id={id('up')} onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move step ${label} up`}>Move up</button>
                  <button type="button" id={id('down')} onClick={() => move(index, 1)} disabled={index === steps.length - 1} aria-label={`Move step ${label} down`}>Move down</button>
                  <button type="button" onClick={() => onChange((current) => removeStep(current, index))} aria-label={`Remove step ${label}`}>Remove</button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      {errorsAt('steps').length > 0 && <p role="alert">{errorsAt('steps').join(' ')}</p>}
      <p>
        <button type="button" data-testid="steps-add-human" onClick={() => onChange((current) => [...current, newStep(current, 'human')])}>Add human step</button>{' '}
        <button type="button" data-testid="steps-add-automated" onClick={() => onChange((current) => [...current, newStep(current, 'automated')])}>Add automated step</button>
      </p>
    </section>
  );
}

interface ParamInputProps {
  spec: ParamSpec;
  id: string;
  step: DraftStep;
  fields: CaptureField[];
  errors: string[];
  testId: string;
  onInput: (value: string | string[]) => void;
}

/** One input of a transform's parameter form, chosen by the param's kind. */
function ParamInput({ spec, id, step, fields, errors, testId, onInput }: ParamInputProps) {
  const input = step.inputs[spec.name];
  const text = typeof input === 'string' ? input : '';
  const empty = spec.kind === 'fields' ? !Array.isArray(input) || input.length === 0 : text === '';
  // An empty input the param needs says so plainly, rather than the schema's own message.
  const shown = empty && !spec.optional && errors.length > 0 ? ['Required'] : errors;
  const error = shown.length > 0 ? <span id={`${id}-error`} role="alert" data-testid={testId}>{shown.join(' ')}</span> : null;
  const title = `${spec.title}${spec.optional ? ' (optional)' : ''}`;

  if (spec.kind === 'fields') {
    const chosen = Array.isArray(input) ? input : [];
    return (
      <fieldset aria-describedby={`${id}-error`}>
        <legend>{title}</legend>
        {fieldsFor(spec, fields).map((f) => (
          <label key={f.key}>
            <input type="checkbox" checked={chosen.includes(f.key)} onChange={(e) => onInput(e.target.checked ? [...chosen, f.key] : chosen.filter((k) => k !== f.key))} /> {f.label || f.key}
          </label>
        ))}
        {error}
      </fieldset>
    );
  }

  let control;
  if (spec.kind === 'field' || spec.kind === 'choice') {
    const options = spec.kind === 'field' ? fieldsFor(spec, fields).map((f) => ({ value: f.key, label: f.label || f.key })) : spec.options.map((o) => ({ value: o, label: o }));
    control = (
      <select id={id} value={text} onChange={(e) => onInput(e.target.value)} aria-describedby={`${id}-error`}>
        <option value="">{spec.kind === 'field' ? 'Choose a field' : 'Choose one'}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else {
    // A constant takes the type of the field it is for: a boolean field's true or false, a select's options.
    const target = fields.find((f) => f.key === step.inputs[spec.of]);
    const choices = target?.type === 'boolean' ? ['true', 'false'] : target?.type === 'select' ? (target.options ?? []) : undefined;
    control = choices
      ? (
          <select id={id} value={text} onChange={(e) => onInput(e.target.value)} aria-describedby={`${id}-error`}>
            <option value="">Choose one</option>
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )
      : <input id={id} value={text} type={target?.type === 'date' ? 'date' : 'text'} inputMode={target?.type === 'number' ? 'decimal' : undefined} onChange={(e) => onInput(e.target.value)} aria-describedby={`${id}-error`} />;
  }
  return (
    <div>
      <label htmlFor={id}>{title}</label>
      {control}
      {error}
    </div>
  );
}
