import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { WorkTypeDefinition } from '../src/domain.js';
import { describeParams, fieldRef, stepProblems, TRANSFORM_NAMES, TRANSFORM_PARAMS } from '../src/process.js';

const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'qty', label: 'Quantity', type: 'number', required: false, min: 0 },
  { key: 'price', label: 'Price', type: 'number', required: false },
  { key: 'total', label: 'Total', type: 'number', required: false },
  { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
];

function definition(steps: unknown[]): WorkTypeDefinition {
  return { fields, steps: steps as WorkTypeDefinition['steps'], outputs: [{ id: 'keep', kind: 'persist', config: {} }] };
}

describe('TRANSFORM_PARAMS', () => {
  it('names the five v1 transforms', () => {
    expect(TRANSFORM_NAMES).toEqual(['set_field', 'copy_field', 'string_case', 'arithmetic', 'require_fields']);
  });
});

describe('describeParams', () => {
  it('describes every v1 transform\'s params as form inputs', () => {
    expect(describeParams(TRANSFORM_PARAMS.set_field)).toEqual([
      { name: 'field', title: 'Field', kind: 'field', optional: false },
      { name: 'value', title: 'Value', kind: 'value', of: 'field', optional: false },
    ]);
    expect(describeParams(TRANSFORM_PARAMS.copy_field).map((p) => [p.name, p.kind])).toEqual([['from', 'field'], ['to', 'field']]);
    expect(describeParams(TRANSFORM_PARAMS.string_case)).toEqual([
      { name: 'field', title: 'Field', kind: 'field', fieldTypes: ['text', 'longtext'], optional: false },
      { name: 'op', title: 'Change', kind: 'choice', options: ['upper', 'lower', 'trim'], optional: false },
    ]);
    expect(describeParams(TRANSFORM_PARAMS.arithmetic).map((p) => [p.name, p.kind])).toEqual([['op', 'choice'], ['left', 'field'], ['right', 'field'], ['into', 'field']]);
    expect(describeParams(TRANSFORM_PARAMS.require_fields)).toEqual([{ name: 'fields', title: 'Fields', kind: 'fields', optional: false }]);
  });

  it('describes optional params, untitled params by name, and refuses shapes it cannot render', () => {
    expect(describeParams(z.object({ note: fieldRef('Note').optional(), mode: z.enum(['a', 'b']) }))).toEqual([
      { name: 'note', title: 'Note', kind: 'field', optional: true },
      { name: 'mode', title: 'mode', kind: 'choice', options: ['a', 'b'], optional: false },
    ]);
    expect(() => describeParams(z.string())).toThrow('params must be an object');
    expect(() => describeParams(z.object({ when: z.date() }))).toThrow('param "when" has a shape the form cannot render');
    expect(() => describeParams(z.object({ list: z.array(z.number()) }))).toThrow('param "list" has a shape the form cannot render');
  });
});

describe('stepProblems', () => {
  it('accepts a definition whose automated steps name known transforms with valid params over its fields', () => {
    expect(stepProblems(definition([
      { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' },
      { id: 'up', name: 'Upper', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'upper' } },
      { id: 'sum', name: 'Total', kind: 'automated', transform: 'arithmetic', params: { op: 'multiply', left: 'qty', right: 'price', into: 'total' } },
      { id: 'flag', name: 'Flag', kind: 'automated', transform: 'set_field', params: { field: 'urgent', value: true } },
      { id: 'need', name: 'Need', kind: 'automated', transform: 'require_fields', params: { fields: ['title', 'qty'] } },
      { id: 'copy', name: 'Copy', kind: 'automated', transform: 'copy_field', params: { from: 'qty', to: 'price' } },
    ]))).toEqual({});
  });

  it('an unknown transform name is reported at the step\'s transform', () => {
    expect(stepProblems(definition([{ id: 's', name: 'S', kind: 'automated', transform: 'run_shell', params: {} }]))).toEqual({ 'steps.0.transform': ['Unknown transform "run_shell"'] });
  });

  it('params that do not parse are reported at each param', () => {
    const problems = stepProblems(definition([
      { id: 'a', name: 'A', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'shout' } },
      { id: 'b', name: 'B', kind: 'automated', transform: 'require_fields', params: { fields: [], extra: 1 } },
    ]));
    expect(Object.keys(problems).sort()).toEqual(['steps.0.params.op', 'steps.1.params', 'steps.1.params.fields']);
  });

  it('a param naming a field the definition does not have, or a field of the wrong type, is refused', () => {
    expect(stepProblems(definition([
      { id: 'a', name: 'A', kind: 'automated', transform: 'copy_field', params: { from: 'nope', to: 'title' } },
      { id: 'b', name: 'B', kind: 'automated', transform: 'arithmetic', params: { op: 'add', left: 'title', right: 'qty', into: 'total' } },
      { id: 'c', name: 'C', kind: 'automated', transform: 'require_fields', params: { fields: ['title', 'gone'] } },
    ]))).toEqual({
      'steps.0.params.from': ['No field "nope" in this work type'],
      'steps.1.params.left': ['Must be a field of type number'],
      'steps.2.params.fields': ['No field "gone" in this work type'],
    });
  });

  it('a set_field value must be a valid value for its field', () => {
    expect(stepProblems(definition([
      { id: 'a', name: 'A', kind: 'automated', transform: 'set_field', params: { field: 'qty', value: -1 } },
      { id: 'b', name: 'B', kind: 'automated', transform: 'set_field', params: { field: 'urgent', value: 'yes' } },
    ]))).toEqual({ 'steps.0.params.value': ['Must be at least 0'], 'steps.1.params.value': ['Must be true or false'] });
  });

  it('a step id that cannot be a URL path segment is refused, for human and automated steps alike', () => {
    expect(stepProblems(definition([
      { id: '', name: 'Empty', kind: 'human', assigneeRole: 'member' },
      { id: '..', name: 'Dots', kind: 'human', assigneeRole: 'member' },
      { id: 'a/b', name: 'Slash', kind: 'automated', transform: 'require_fields', params: { fields: ['title'] } },
      { id: 'Review-2_b', name: 'Fine', kind: 'human', assigneeRole: 'admin' },
    ]))).toEqual({
      'steps.0.id': ['Use 1 to 64 letters, digits, dashes and underscores'],
      'steps.1.id': ['Use 1 to 64 letters, digits, dashes and underscores'],
      'steps.2.id': ['Use 1 to 64 letters, digits, dashes and underscores'],
    });
  });

  // GWP#54: a human step's decisions, recorded on its step_completed event (D-028: never a branch).
  it('a human step with 1 to 10 distinct decisions of 1 to 40 characters passes', () => {
    expect(stepProblems(definition([
      { id: 'approve', name: 'Approve', kind: 'human', assigneeRole: 'admin', decisions: ['approve', 'reject'] },
      { id: 'many', name: 'Many', kind: 'human', assigneeRole: 'member', decisions: Array.from({ length: 10 }, (_, i) => `d${i}`.padEnd(40, 'x')) },
      { id: 'none', name: 'None', kind: 'human', assigneeRole: 'member' },
    ]))).toEqual({});
  });

  it('eleven decisions, none, an empty or overlong one, or a duplicate is refused beside the step', () => {
    expect(stepProblems(definition([
      { id: 'eleven', name: 'Eleven', kind: 'human', assigneeRole: 'member', decisions: Array.from({ length: 11 }, (_, i) => `d${i}`) },
      { id: 'empty', name: 'Empty', kind: 'human', assigneeRole: 'member', decisions: ['approve', ''] },
      { id: 'dup', name: 'Duplicate', kind: 'human', assigneeRole: 'member', decisions: ['approve', 'reject', 'approve'] },
      { id: 'long', name: 'Long', kind: 'human', assigneeRole: 'member', decisions: ['x'.repeat(41)] },
      { id: 'zero', name: 'Zero', kind: 'human', assigneeRole: 'member', decisions: [] },
    ]))).toEqual({
      'steps.0.decisions': ['Give 1 to 10 decisions'],
      'steps.1.decisions': ['Each decision is 1 to 40 characters'],
      'steps.2.decisions': ['Duplicate decision "approve"'],
      'steps.3.decisions': ['Each decision is 1 to 40 characters'],
      'steps.4.decisions': ['Give 1 to 10 decisions'],
    });
  });

  it('checks against the registry it is given', () => {
    const registry = new Map([['only', { params: z.object({}).strict() }]]);
    expect(stepProblems(definition([{ id: 'a', name: 'A', kind: 'automated', transform: 'set_field', params: {} }]), registry)).toEqual({ 'steps.0.transform': ['Unknown transform "set_field"'] });
  });
});
