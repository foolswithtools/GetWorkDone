import type { CaptureField } from '@getworkdone/contracts';
import { TRANSFORM_NAMES } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { runTransform, TransformFailure, TRANSFORMS, type TransformContext } from '../src/modules/process/transforms.js';

// Unit partition: each v1 transform (GWP#5, docs/process.md) on its happy path, its params refused,
// and its purity: the input data is frozen, so a transform that wrote to it would throw, and it is
// compared with a copy afterwards.
const fields: CaptureField[] = [
  { key: 'title', label: 'Title', type: 'text', required: true, max: 20 },
  { key: 'note', label: 'Note', type: 'longtext', required: false },
  { key: 'qty', label: 'Quantity', type: 'number', required: false },
  { key: 'price', label: 'Price', type: 'number', required: false },
  { key: 'total', label: 'Total', type: 'number', required: false, max: 1000 },
  { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
];

function context(data: Record<string, unknown>): TransformContext {
  return { data: Object.freeze({ ...data }), fields };
}

function transform(name: string) {
  const found = TRANSFORMS.get(name);
  if (!found) throw new Error(`no transform ${name}`);
  return found;
}

/** Applies `name` with params parsed by its own schema, and checks the input was not changed. */
function apply(name: string, data: Record<string, unknown>, params: unknown): Record<string, unknown> {
  const t = transform(name);
  const ctx = context(data);
  const before = structuredClone(ctx.data);
  const result = t.apply(ctx, t.params.parse(params));
  expect(ctx.data).toEqual(before);
  expect(result).not.toBe(ctx.data);
  return result;
}

const refuses = (name: string, params: unknown) => expect(transform(name).params.safeParse(params).success).toBe(false);

describe('TRANSFORMS', () => {
  it('holds exactly the contract\'s transforms, each under its own name', () => {
    expect([...TRANSFORMS.keys()]).toEqual(TRANSFORM_NAMES);
    for (const [name, t] of TRANSFORMS) expect(t.name).toBe(name);
  });

  describe('set_field', () => {
    it('sets the field to the constant value', () => {
      expect(apply('set_field', { title: 'a' }, { field: 'urgent', value: true })).toEqual({ title: 'a', urgent: true });
    });
    it('refuses params without a field or with a value that is not a scalar', () => {
      refuses('set_field', { value: 1 });
      refuses('set_field', { field: 'urgent', value: { nested: true } });
    });
  });

  describe('copy_field', () => {
    it('copies one field\'s value to another; copying an absent field leaves the target absent', () => {
      expect(apply('copy_field', { title: 'a', note: 'old' }, { from: 'title', to: 'note' })).toEqual({ title: 'a', note: 'a' });
      expect(apply('copy_field', { title: 'a', price: 3 }, { from: 'qty', to: 'price' })).toEqual({ title: 'a' });
    });
    it('refuses params without both fields', () => {
      refuses('copy_field', { from: 'title' });
      refuses('copy_field', { from: 'title', to: 'Not A Key' });
    });
  });

  describe('string_case', () => {
    it('upper-cases, lower-cases and trims; an absent field is left absent', () => {
      expect(apply('string_case', { title: 'Mixed' }, { field: 'title', op: 'upper' })).toEqual({ title: 'MIXED' });
      expect(apply('string_case', { title: 'Mixed' }, { field: 'title', op: 'lower' })).toEqual({ title: 'mixed' });
      expect(apply('string_case', { title: '  spaced  ' }, { field: 'title', op: 'trim' })).toEqual({ title: 'spaced' });
      expect(apply('string_case', { title: 'a' }, { field: 'note', op: 'upper' })).toEqual({ title: 'a' });
    });
    it('refuses an unknown op', () => {
      refuses('string_case', { field: 'title', op: 'shout' });
    });
    it('fails on a value that is not text', () => {
      expect(() => apply('string_case', { title: 5 }, { field: 'title', op: 'upper' })).toThrow(new TransformFailure('Field "title" is not text'));
    });
  });

  describe('arithmetic', () => {
    it('adds, subtracts and multiplies two number fields into a third', () => {
      const data = { title: 'a', qty: 3, price: 4 };
      expect(apply('arithmetic', data, { op: 'add', left: 'qty', right: 'price', into: 'total' })).toEqual({ ...data, total: 7 });
      expect(apply('arithmetic', data, { op: 'subtract', left: 'qty', right: 'price', into: 'total' })).toEqual({ ...data, total: -1 });
      expect(apply('arithmetic', data, { op: 'multiply', left: 'qty', right: 'price', into: 'total' })).toEqual({ ...data, total: 12 });
    });
    it('refuses an unknown op or a missing operand', () => {
      refuses('arithmetic', { op: 'divide', left: 'qty', right: 'price', into: 'total' });
      refuses('arithmetic', { op: 'add', left: 'qty', into: 'total' });
    });
    it('fails on an operand that is empty or not a number, and on a result that is not finite', () => {
      expect(() => apply('arithmetic', { qty: 3 }, { op: 'add', left: 'qty', right: 'price', into: 'total' })).toThrow(new TransformFailure('Field "price" is empty'));
      expect(() => apply('arithmetic', { qty: 3, price: 'x' }, { op: 'add', left: 'qty', right: 'price', into: 'total' })).toThrow(new TransformFailure('Field "price" is not a number'));
      expect(() => apply('arithmetic', { qty: 1e308, price: 1e308 }, { op: 'multiply', left: 'qty', right: 'price', into: 'total' })).toThrow(new TransformFailure('The result is not a finite number'));
    });
  });

  describe('require_fields', () => {
    it('passes the data through when every listed field has a value', () => {
      expect(apply('require_fields', { title: 'a', qty: 0, urgent: false }, { fields: ['title', 'qty', 'urgent'] })).toEqual({ title: 'a', qty: 0, urgent: false });
    });
    it('refuses an empty list', () => {
      refuses('require_fields', { fields: [] });
    });
    it('fails listing the fields that are absent, null or blank text', () => {
      expect(() => apply('require_fields', { title: '  ', note: null }, { fields: ['title', 'note', 'qty'] })).toThrow(new TransformFailure('Required fields are empty: title, note, qty'));
    });
  });
});

describe('runTransform', () => {
  const step = (transform: string, params: Record<string, unknown>) => ({ id: 's', name: 'S', kind: 'automated' as const, transform, params });

  it('returns the new data, re-validated by validateCapture', () => {
    expect(runTransform(step('string_case', { field: 'title', op: 'upper' }), { title: 'abc' }, fields)).toEqual({ ok: true, data: { title: 'ABC' } });
  });

  it('fails when the output does not pass validateCapture, with its errors', () => {
    expect(runTransform(step('arithmetic', { op: 'multiply', left: 'qty', right: 'price', into: 'total' }), { title: 'a', qty: 100, price: 100 }, fields)).toEqual({
      ok: false, reason: 'The result does not pass the work type\'s validation', errors: { total: ['Must be at most 1000'] },
    });
  });

  it('fails with the transform\'s reason, for an unknown transform, and for params that no longer parse', () => {
    expect(runTransform(step('require_fields', { fields: ['qty'] }), { title: 'a' }, fields)).toEqual({ ok: false, reason: 'Required fields are empty: qty' });
    expect(runTransform(step('run_shell', {}), { title: 'a' }, fields)).toEqual({ ok: false, reason: 'Unknown transform "run_shell"' });
    expect(runTransform(step('string_case', { field: 'title' }), { title: 'a' }, fields)).toMatchObject({ ok: false, reason: 'The step\'s params are invalid' });
  });

  it('an unexpected error inside a transform is a failed step, not a thrown error', () => {
    const failing = new Map(TRANSFORMS);
    failing.set('boom', { name: 'boom', params: transform('require_fields').params, apply: () => { throw new Error('bug'); } });
    expect(runTransform(step('boom', { fields: ['title'] }), { title: 'a' }, fields, failing)).toEqual({ ok: false, reason: 'Transform "boom" failed unexpectedly' });
  });
});
