import { describe, expect, it } from 'vitest';
import { CaptureField, ItemStatus, MAX_OUTPUTS, ProcessStep, WorkTypeDefinition } from '../src/domain.js';

// Three fields, two steps (one human, one automated), persist plus webhook.
const valid = {
  fields: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'high'] },
    { key: 'due_on', label: 'Due on', type: 'date' },
  ],
  steps: [
    { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'admin' },
    { id: 'tag', name: 'Tag', kind: 'automated', transform: 'uppercase', params: { field: 'title' } },
  ],
  outputs: [
    { id: 'keep', kind: 'persist', config: {} },
    { id: 'notify', kind: 'webhook', config: { url: 'https://example.com/hook' } },
  ],
};

function issues(input: unknown): string[] {
  const result = WorkTypeDefinition.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('WorkTypeDefinition', () => {
  // GWP#50: one completed item fans out to at most MAX_OUTPUTS outputs.
  it('refuses six outputs at path `outputs`; five pass', () => {
    const outputs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `keep-${i}`, kind: 'persist', config: {} }));
    expect(MAX_OUTPUTS).toBe(5);
    expect(WorkTypeDefinition.safeParse({ ...valid, outputs: outputs(5) }).success).toBe(true);
    const refused = WorkTypeDefinition.safeParse({ ...valid, outputs: outputs(6) });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([{ path: ['outputs'], message: 'At most 5 outputs' }]);
  });

  it('accepts a three-field, two-step definition with persist plus webhook outputs', () => {
    const parsed = WorkTypeDefinition.parse(valid);
    expect(parsed.steps.map((s) => s.id)).toEqual(['review', 'tag']);
    // `required` defaults to false where the definition leaves it out.
    expect(parsed.fields.map((f) => f.required)).toEqual([true, false, false]);
  });

  it('rejects duplicate field keys', () => {
    const fields = [...valid.fields, { key: 'title', label: 'Title again', type: 'longtext' }];
    expect(issues({ ...valid, fields })).toEqual(['duplicate field key "title"']);
  });

  it('rejects duplicate step ids', () => {
    const steps = [...valid.steps, { id: 'review', name: 'Second review', kind: 'human', assigneeRole: 'member' }];
    expect(issues({ ...valid, steps })).toEqual(['duplicate step id "review"']);
  });

  it('rejects `none` combined with `email`', () => {
    const outputs = [{ id: 'drop', kind: 'none', config: {} }, { id: 'mail', kind: 'email', config: {} }];
    expect(issues({ ...valid, outputs })).toEqual(['output `none` excludes every other output']);
  });

  it('accepts `none` on its own', () => {
    expect(WorkTypeDefinition.safeParse({ ...valid, outputs: [{ id: 'drop', kind: 'none', config: {} }] }).success).toBe(true);
  });

  it('rejects empty outputs and empty fields', () => {
    expect(WorkTypeDefinition.safeParse({ ...valid, outputs: [] }).success).toBe(false);
    expect(WorkTypeDefinition.safeParse({ ...valid, fields: [] }).success).toBe(false);
  });

  it('rejects an unknown output kind and an unknown step kind', () => {
    expect(WorkTypeDefinition.safeParse({ ...valid, outputs: [{ id: 'x', kind: 'fax', config: {} }] }).success).toBe(false);
    expect(WorkTypeDefinition.safeParse({ ...valid, steps: [{ id: 'x', name: 'X', kind: 'robot' }] }).success).toBe(false);
  });

  it('accepts no steps: array order is execution order, and zero steps is allowed', () => {
    expect(WorkTypeDefinition.safeParse({ ...valid, steps: [] }).success).toBe(true);
  });
});

describe('CaptureField, ProcessStep and ItemStatus', () => {
  it('field keys are lower snake case starting with a letter, at most 63 characters', () => {
    const field = { label: 'L', type: 'text' };
    expect(CaptureField.safeParse({ ...field, key: 'a'.repeat(63) }).success).toBe(true);
    for (const key of ['a'.repeat(64), 'Title', '1st', '_x', 'due-on', '']) {
      expect(CaptureField.safeParse({ ...field, key }).success, key).toBe(false);
    }
  });

  it('a human step needs a member or admin assignee role', () => {
    expect(ProcessStep.safeParse({ id: 's', name: 'S', kind: 'human', assigneeRole: 'owner' }).success).toBe(false);
  });

  it('a human step may list 1 to 10 decisions of 1 to 40 characters (GWP#54)', () => {
    const step = { id: 's', name: 'S', kind: 'human', assigneeRole: 'admin' } as const;
    expect(ProcessStep.parse({ ...step, decisions: ['approve', 'reject'] })).toEqual({ ...step, decisions: ['approve', 'reject'] });
    expect(ProcessStep.parse(step)).toEqual(step);
    for (const decisions of [[], Array.from({ length: 11 }, (_, i) => `d${i}`), [''], ['x'.repeat(41)]]) {
      expect(ProcessStep.safeParse({ ...step, decisions }).success, JSON.stringify(decisions)).toBe(false);
    }
  });

  it('item statuses are the five in the contract', () => {
    expect(ItemStatus.options).toEqual(['open', 'in_progress', 'completed', 'failed', 'cancelled']);
  });
});
