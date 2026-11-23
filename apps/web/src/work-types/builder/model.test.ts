import { WorkTypeDefinition } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { buildDefinition, definitionErrors, draftFromField, fieldFromDraft, moveField, newDraftField, removeField, updateField, type DraftField } from './model.js';

const draft = (over: Partial<DraftField> = {}): DraftField => ({ ...newDraftField([]), ...over });

describe('builder model', () => {
  it('a new field gets the next free key and is a required-off text field', () => {
    const first = newDraftField([]);
    expect(first).toMatchObject({ key: 'field_1', label: 'Field 1', type: 'text', required: false, options: '', min: '', max: '', pattern: '' });
    expect(newDraftField([first, draft({ key: 'field_2' })]).key).toBe('field_3');
    expect(newDraftField([first]).id).not.toBe(first.id);
  });

  it('moves a field up or down and leaves the list alone at either end', () => {
    const [a, b, c] = [draft({ key: 'a' }), draft({ key: 'b' }), draft({ key: 'c' })];
    expect(moveField([a, b, c], 2, -1).map((f) => f.key)).toEqual(['a', 'c', 'b']);
    expect(moveField([a, b, c], 0, 1).map((f) => f.key)).toEqual(['b', 'a', 'c']);
    expect(moveField([a, b, c], 0, -1)).toEqual([a, b, c]);
    expect(moveField([a, b, c], 2, 1)).toEqual([a, b, c]);
  });

  it('updates and removes a field by index without touching the others', () => {
    const [a, b] = [draft({ key: 'a' }), draft({ key: 'b' })];
    expect(updateField([a, b], 1, { label: 'B' })).toEqual([a, { ...b, label: 'B' }]);
    expect(removeField([a, b], 0)).toEqual([b]);
  });

  it('turns a draft into a field with only the settings its type takes', () => {
    expect(fieldFromDraft(draft({ key: 'title', label: 'Title', required: true, min: '2', max: '40', pattern: '[A-Z].*', options: 'ignored' })))
      .toEqual({ key: 'title', label: 'Title', type: 'text', required: true, min: 2, max: 40, pattern: '[A-Z].*' });
    expect(fieldFromDraft(draft({ key: 'size', label: 'Size', type: 'select', options: ' s, m \n l,, ', min: '1', pattern: 'x' })))
      .toEqual({ key: 'size', label: 'Size', type: 'select', required: false, options: ['s', 'm', 'l'] });
    expect(fieldFromDraft(draft({ key: 'n', label: 'N', type: 'number', min: '-1.5', max: '' }))).toEqual({ key: 'n', label: 'N', type: 'number', required: false, min: -1.5 });
    expect(fieldFromDraft(draft({ key: 'd', label: 'D', type: 'date', min: '1', max: '2', pattern: 'x' }))).toEqual({ key: 'd', label: 'D', type: 'date', required: false });
  });

  it('a limit that is not a number is kept as NaN so the definition check refuses it', () => {
    expect(fieldFromDraft(draft({ min: 'abc' })).min).toBeNaN();
    expect(Object.keys(definitionErrors(buildDefinition([draft({ min: 'abc' })])))).toEqual(['fields.0.min']);
  });

  it('round-trips a stored field into a draft', () => {
    const field = { key: 'size', label: 'Size', type: 'select' as const, required: true, options: ['s', 'm'] };
    expect(fieldFromDraft(draftFromField(field))).toEqual(field);
    const text = { key: 't', label: 'T', type: 'text' as const, required: false, min: 1, max: 9, pattern: '\\d+' };
    expect(fieldFromDraft(draftFromField(text))).toEqual(text);
  });

  it('builds a definition that keeps the stored steps and outputs, or a persist output for a new work type', () => {
    const fresh = buildDefinition([draft({ key: 'title', label: 'Title' })]);
    expect(fresh).toEqual({ fields: [{ key: 'title', label: 'Title', type: 'text', required: false }], steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] });
    expect(WorkTypeDefinition.safeParse(fresh).success).toBe(true);
    const base = { fields: [], steps: [{ id: 'r', name: 'R', kind: 'human' as const, assigneeRole: 'admin' as const }], outputs: [{ id: 'mail', kind: 'email' as const, config: {} }] };
    expect(buildDefinition([draft()], base)).toMatchObject({ steps: base.steps, outputs: base.outputs });
  });

  it('definition errors are keyed by path, including the contract\'s definition-time checks', () => {
    expect(definitionErrors(buildDefinition([draft({ key: 'title', label: 'Title' })]))).toEqual({});
    const errors = definitionErrors(buildDefinition([draft({ pattern: '(a+)+$' }), draft({ key: 'Bad key', label: '' }), draft({ type: 'select' })]));
    expect(errors['fields.0.pattern']).toEqual(['Pattern could take too long to check: a repeated group contains a repeat']);
    expect(Object.keys(errors).sort()).toEqual(['fields', 'fields.0.pattern', 'fields.1.key', 'fields.1.label', 'fields.2.options']);
    expect(definitionErrors(buildDefinition([]))).toEqual({ fields: [expect.any(String)] });
  });
});

describe('steps in the definition (GWP#5)', () => {
  const title = () => draft({ key: 'title', label: 'Title' });

  it('the step editor\'s steps replace the stored ones', () => {
    const steps: WorkTypeDefinition['steps'] = [{ id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' }];
    const base = WorkTypeDefinition.parse({ fields: [{ key: 'a', label: 'A', type: 'text' }], steps: [{ id: 'old', name: 'Old', kind: 'human', assigneeRole: 'admin' }], outputs: [{ id: 'keep', kind: 'persist', config: {} }] });
    expect(buildDefinition([title()], base, steps).steps).toEqual(steps);
  });

  it('definitionErrors includes the contract\'s step checks: an unknown transform, a missing field', () => {
    expect(definitionErrors(buildDefinition([title()], undefined, [
      { id: 'a', name: 'A', kind: 'automated', transform: 'nope', params: {} },
      { id: 'b', name: 'B', kind: 'automated', transform: 'copy_field', params: { from: 'title', to: 'gone' } },
    ]))).toEqual({ 'steps.0.transform': ['Unknown transform "nope"'], 'steps.1.params.to': ['No field "gone" in this work type'] });
  });

  it('buildDefinition takes the output editor\'s outputs, and definitionErrors includes the output checks (GWP#6)', () => {
    const outputs = [{ id: 'hook', kind: 'webhook' as const, config: { url: 'http://hooks.example.com/' } }];
    const built = buildDefinition([title()], undefined, [], outputs);
    expect(built.outputs).toEqual(outputs);
    expect(definitionErrors(built)).toEqual({ 'outputs.0.config.url': ['Use an https:// URL without a user name or password'] });
  });
});
