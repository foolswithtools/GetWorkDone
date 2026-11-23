import { MAX_DEADLINE_MS, MAX_RECIPIENTS, OutputKind } from '@getworkdone/contracts';
import { newOutput, OUTPUT_KIND_TITLES, removeOutput, updateOutput, type DraftOutput } from './model.js';

interface Props {
  outputs: DraftOutput[];
  /** The builder's errors at a definition path (`outputs.0.config.url`), local and from the server. */
  errorsAt: (path: string) => string[];
  onChange: (next: (current: DraftOutput[]) => DraftOutput[]) => void;
}

/**
 * The builder's output editor (GWP#6, docs/outputs.md): where a completed item goes. Each output has a
 * kind and that kind's settings; a webhook's signing secret is generated when the work type is saved and
 * shown once then. A webhook URL is checked for its shape here and for its address only when it is sent
 * to, so an address the API will refuse can still be saved.
 */
export function OutputsEditor({ outputs, errorsAt, onChange }: Props) {
  const change = (index: number, patch: Partial<DraftOutput>) => onChange((current) => updateOutput(current, index, patch));

  return (
    <section aria-labelledby="builder-outputs-title" data-testid="builder-outputs">
      <h4 id="builder-outputs-title">Outputs</h4>
      <ol>
        {outputs.map((output, index) => {
          const id = (part: string) => `output-${output.draftId}-${part}`;
          const errors = (path: string) => errorsAt(`outputs.${index}.${path}`);
          const errorList = (path: string) => {
            const messages = errors(path);
            return messages.length > 0 ? <span id={`${id(path)}-error`} role="alert" data-testid={`builder-output-${index}-${path.replaceAll('.', '-')}-error`}>{messages.join(' ')}</span> : null;
          };
          const input = (part: 'url' | 'deadline' | 'subject', label: string, path: string, extra: { placeholder?: string; inputMode?: 'numeric' } = {}) => (
            <div>
              <label htmlFor={id(part)}>{label}</label>
              <input id={id(part)} value={output[part]} onChange={(e) => change(index, { [part]: e.target.value })} aria-describedby={`${id(path)}-error`} {...extra} />
              {errorList(path)}
            </div>
          );
          return (
            <li key={output.draftId} data-testid="builder-output">
              <fieldset>
                <legend>Output {index + 1}: {output.kind} ({output.id})</legend>
                <div>
                  <label htmlFor={id('kind')}>Kind</label>
                  <select id={id('kind')} value={output.kind} onChange={(e) => change(index, { kind: e.target.value as DraftOutput['kind'] })}>
                    {OutputKind.options.map((k) => <option key={k} value={k}>{k}: {OUTPUT_KIND_TITLES[k]}</option>)}
                  </select>
                  {errorList('id')}
                </div>
                {output.kind === 'webhook' && (
                  <>
                    {input('url', 'URL (https)', 'config.url', { placeholder: 'https://' })}
                    {input('deadline', `Deadline per attempt in ms (optional, default 10000, at most ${MAX_DEADLINE_MS})`, 'config.deadlineMs', { inputMode: 'numeric' })}
                    <p>Each POST carries an Idempotency-Key and an X-GetWorkDone-Signature; the signing secret is shown once, when you save.</p>
                  </>
                )}
                {output.kind === 'email' && (
                  <>
                    <div>
                      <label htmlFor={id('recipients')}>Recipients (one per line, at most {MAX_RECIPIENTS})</label>
                      <textarea id={id('recipients')} value={output.recipients} onChange={(e) => change(index, { recipients: e.target.value })} aria-describedby={`${id('config.recipients')}-error`} />
                      {errorList('config.recipients')}
                      {output.recipients.split(/[\n,]/).map((_, i) => errors(`config.recipients.${i}`).length > 0 && <span key={i} role="alert">Recipient {i + 1}: {errors(`config.recipients.${i}`).join(' ')}</span>)}
                    </div>
                    {input('subject', 'Subject (optional)', 'config.subject')}
                    {input('deadline', `Deadline per attempt in ms (optional, default 10000, at most ${MAX_DEADLINE_MS})`, 'config.deadlineMs', { inputMode: 'numeric' })}
                  </>
                )}
                {output.kind === 'export' && (
                  <div>
                    <label htmlFor={id('format')}>Default format</label>
                    <select id={id('format')} value={output.format} onChange={(e) => change(index, { format: e.target.value as DraftOutput['format'] })}>
                      <option value="csv">CSV</option>
                      <option value="json">JSON</option>
                    </select>
                  </div>
                )}
                {errorList('config')}
                <p>
                  <button type="button" onClick={() => onChange((current) => removeOutput(current, index))} aria-label={`Remove output ${output.id}`}>Remove</button>
                </p>
              </fieldset>
            </li>
          );
        })}
      </ol>
      {errorsAt('outputs').length > 0 && <p role="alert" data-testid="builder-outputs-error">{errorsAt('outputs').join(' ')}</p>}
      <p>
        <button type="button" data-testid="outputs-add" onClick={() => onChange((current) => [...current, newOutput(current, 'webhook')])}>Add output</button>
      </p>
    </section>
  );
}
