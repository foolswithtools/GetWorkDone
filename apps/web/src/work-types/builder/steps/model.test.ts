import type { CaptureField, ProcessStep } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { changeTransform, draftFromStep, fieldsFor, inputsFor, moveStep, newStep, removeStep, stepFromDraft, updateStep, type DraftStep } from './model.js';

const fields: CaptureField[] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'qty', label: 'Quantity', type: 'number', required: false },
  { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
];

describe('step drafts', () => {
  it('a new step takes the first free step_N id; human steps default to members, automated to set_field', () => {
    const first = newStep([], 'human');
    expect(first).toMatchObject({ id: 'step_1', name: '', kind: 'human', assigneeRole: 'member' });
    const second = newStep([first, { ...first, draftId: 'x', id: 'step_3' }], 'automated');
    expect(second).toMatchObject({ id: 'step_2', kind: 'automated', transform: 'set_field', inputs: {} });
    expect(second.draftId).not.toBe(first.draftId);
  });

  it('moves, updates and removes steps without touching the others', () => {
    const steps = [newStep([], 'human'), newStep([], 'automated')].map((s, i) => ({ ...s, id: `s${i}` }));
    expect(moveStep(steps, 1, -1).map((s) => s.id)).toEqual(['s1', 's0']);
    expect(moveStep(steps, 1, 1)).toBe(steps);
    expect(updateStep(steps, 0, { name: 'Review' }).map((s) => s.name)).toEqual(['Review', '']);
    expect(removeStep(steps, 0).map((s) => s.id)).toEqual(['s1']);
  });

  it('changing the transform clears the inputs typed for the old one', () => {
    const step = { ...newStep([], 'automated'), inputs: { field: 'title' } };
    expect(changeTransform(step, 'string_case')).toMatchObject({ transform: 'string_case', inputs: {} });
  });
});

describe('the parameter form', () => {
  it('has one input per param of the transform, generated from its Zod params', () => {
    expect(inputsFor('string_case').map((p) => [p.name, p.title, p.kind])).toEqual([['field', 'Field', 'field'], ['op', 'Change', 'choice']]);
    expect(inputsFor('not_a_transform')).toEqual([]);
  });

  it('offers only the fields of the types a param takes', () => {
    const [field] = inputsFor('string_case');
    expect(fieldsFor(field!, fields).map((f) => f.key)).toEqual(['title']);
    expect(fieldsFor(inputsFor('copy_field')[0]!, fields).map((f) => f.key)).toEqual(['title', 'qty', 'urgent']);
  });
});

const paramsOf = (step: ProcessStep) => (step.kind === 'automated' ? step.params : undefined);

describe('stepFromDraft', () => {
  const automated = (transform: string, inputs: DraftStep['inputs']): DraftStep => ({ ...newStep([], 'automated'), id: 'a', name: 'A', transform, inputs });

  it('a human step keeps its id, name and role only', () => {
    expect(stepFromDraft({ ...newStep([], 'human'), id: 'h', name: 'Review', assigneeRole: 'admin' }, fields)).toEqual({ id: 'h', name: 'Review', kind: 'human', assigneeRole: 'admin' });
  });

  // GWP#54: one decision per line; blank lines are dropped, duplicates kept so the save refuses them.
  it('a human step\'s decisions are its lines, trimmed, without blank ones; none typed means no decisions', () => {
    const human = { ...newStep([], 'human'), id: 'h', name: 'Approve' };
    expect(stepFromDraft({ ...human, decisions: ' approve \n\nreject\n approve' }, fields)).toEqual({ id: 'h', name: 'Approve', kind: 'human', assigneeRole: 'member', decisions: ['approve', 'reject', 'approve'] });
    expect(stepFromDraft({ ...human, decisions: ' \n ' }, fields)).toEqual({ id: 'h', name: 'Approve', kind: 'human', assigneeRole: 'member' });
    expect(human.decisions).toBe('');
  });

  it('turns the typed inputs into params; a constant takes its field\'s type', () => {
    expect(stepFromDraft(automated('string_case', { field: 'title', op: 'upper' }), fields)).toEqual({ id: 'a', name: 'A', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'upper' } });
    expect(paramsOf(stepFromDraft(automated('set_field', { field: 'qty', value: '12' }), fields))).toEqual({ field: 'qty', value: 12 });
    expect(paramsOf(stepFromDraft(automated('set_field', { field: 'qty', value: 'lots' }), fields))).toEqual({ field: 'qty', value: 'lots' });
    expect(paramsOf(stepFromDraft(automated('set_field', { field: 'urgent', value: 'true' }), fields))).toEqual({ field: 'urgent', value: true });
    expect(paramsOf(stepFromDraft(automated('set_field', { field: 'urgent', value: 'false' }), fields))).toEqual({ field: 'urgent', value: false });
    expect(paramsOf(stepFromDraft(automated('set_field', { field: 'title', value: 'x' }), fields))).toEqual({ field: 'title', value: 'x' });
    expect(paramsOf(stepFromDraft(automated('require_fields', { fields: ['title', 'qty'] }), fields))).toEqual({ fields: ['title', 'qty'] });
  });

  it('leaves out empty inputs, so the contract reports them', () => {
    expect(paramsOf(stepFromDraft(automated('set_field', { field: '', value: '' }), fields))).toEqual({});
    expect(paramsOf(stepFromDraft(automated('require_fields', {}), fields))).toEqual({ fields: [] });
  });

  it('keeps the stored params of a transform the editor does not know, so saving shows the contract\'s error', () => {
    const stored: ProcessStep = { id: 'old', name: 'Old', kind: 'automated', transform: 'uppercase', params: { field: 'title' } };
    expect(stepFromDraft(draftFromStep(stored), fields)).toEqual(stored);
  });
});

describe('draftFromStep', () => {
  it('round-trips every kind of stored step through the editor', () => {
    const stored: ProcessStep[] = [
      { id: 'h', name: 'Review', kind: 'human', assigneeRole: 'admin' },
      { id: 'd', name: 'Approve', kind: 'human', assigneeRole: 'member', decisions: ['approve', 'reject'] },
      { id: 'a', name: 'Set', kind: 'automated', transform: 'set_field', params: { field: 'qty', value: 3 } },
      { id: 'b', name: 'Need', kind: 'automated', transform: 'require_fields', params: { fields: ['title'] } },
      { id: 'c', name: 'Sum', kind: 'automated', transform: 'arithmetic', params: { op: 'add', left: 'qty', right: 'qty', into: 'qty' } },
    ];
    expect(stored.map((s) => stepFromDraft(draftFromStep(s), fields))).toEqual(stored);
    expect(draftFromStep(stored[2]!).inputs).toEqual({ field: 'qty', value: '3' });
    expect(draftFromStep(stored[1]!).decisions).toBe('approve\nreject');
  });
});
