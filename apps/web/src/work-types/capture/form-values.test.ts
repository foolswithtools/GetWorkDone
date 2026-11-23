import type { CaptureField } from '@getworkdone/contracts';
import { validateCapture } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { carryOver, initialValues, toCaptureInput, valuesFrom } from './form-values.js';

const fields: CaptureField[] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false },
  { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
  { key: 'size', label: 'Size', type: 'select', required: false, options: ['s', 'm'] },
];

describe('capture form values', () => {
  it('start empty, with checkboxes unticked', () => {
    expect(initialValues(fields)).toEqual({ title: '', amount: '', urgent: false, size: '' });
  });

  it('an empty input is left out (absent), never sent as an empty string', () => {
    expect(toCaptureInput(fields, initialValues(fields))).toEqual({ urgent: false });
  });

  it('numbers become numbers; text, select and booleans pass through', () => {
    expect(toCaptureInput(fields, { title: 'Desk', amount: ' 12.5 ', urgent: true, size: 'm' })).toEqual({ title: 'Desk', amount: 12.5, urgent: true, size: 'm' });
  });

  it('a number input that is not a number is kept as typed, so both sides say "Must be a number"', () => {
    const input = toCaptureInput(fields, { title: 'Desk', amount: '12abc', urgent: false, size: '' });
    expect(input).toEqual({ title: 'Desk', amount: '12abc', urgent: false });
    // The body survives JSON unchanged, so the API sees exactly what the browser validated.
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
    expect(validateCapture(fields, input)).toEqual({ ok: false, errors: { amount: ['Must be a number'] } });
  });

  it('a value for a key the fields do not name is ignored', () => {
    expect(toCaptureInput(fields, { title: 'x', stale: 'y' })).toEqual({ title: 'x' });
  });

  it('keeps what was typed when the fields change, for keys whose kind is the same', () => {
    const changed: CaptureField[] = [{ key: 'title', label: 'Title', type: 'longtext', required: true }, { key: 'urgent', label: 'Urgent', type: 'text', required: false }, { key: 'new', label: 'New', type: 'boolean', required: false }];
    expect(carryOver(changed, { title: 'Desk', urgent: true, gone: 'x' })).toEqual({ title: 'Desk', urgent: '', new: false });
  });

  // GWP#23: the item view's edit form starts from the item's data.
  it('prefill from an item\'s data: numbers as typed text, booleans kept, absent fields empty', () => {
    expect(valuesFrom(fields, { title: 'Desk', amount: 12.5, urgent: true })).toEqual({ title: 'Desk', amount: '12.5', urgent: true, size: '' });
    expect(valuesFrom(fields, {})).toEqual(initialValues(fields));
    // Prefilled and submitted unchanged, the form sends the same data back.
    const data = { title: 'Desk', amount: 12.5, urgent: false, size: 'm' };
    expect(toCaptureInput(fields, valuesFrom(fields, data))).toEqual(data);
  });

  it('a checkbox prefills only from a boolean, an input only from text or a number', () => {
    expect(valuesFrom(fields, { title: 7, urgent: 'yes', size: null })).toEqual({ title: '7', amount: '', urgent: false, size: '' });
  });
});
