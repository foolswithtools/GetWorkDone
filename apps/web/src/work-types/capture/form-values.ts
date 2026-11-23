// The capture form's inputs as the object both sides validate (GWP#4, docs/capture.md). The form holds
// strings (and booleans for checkboxes); toCaptureInput turns them into the item's data, and that one
// object is what validateCapture checks in the browser and what the POST sends, so the API checks the
// same value and answers with the same messages. An empty input is left out: optional means absent.

import type { CaptureField } from '@getworkdone/contracts';

export type FormValues = Record<string, string | boolean>;

/** Every input empty, every checkbox unticked. */
export function initialValues(fields: CaptureField[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.key, field.type === 'boolean' ? false : '']));
}

/** The item's data from the form: empty inputs left out, numbers parsed, anything unparseable kept as typed. */
export function toCaptureInput(fields: CaptureField[], values: FormValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (typeof value === 'boolean') {
      input[field.key] = value;
    } else if (value !== undefined && value !== '') {
      const number = field.type === 'number' && value.trim() !== '' ? Number(value) : Number.NaN;
      // A number input that is not a finite number stays a string, which validateCapture refuses.
      input[field.key] = Number.isFinite(number) ? number : value;
    }
  }
  return input;
}

/**
 * The form's values from an item's data, for an admin's edit (GWP#23): a checkbox from a boolean, any
 * other input from text or a number written as text; anything else, or an absent field, starts empty.
 */
export function valuesFrom(fields: CaptureField[], data: Record<string, unknown>): FormValues {
  const values = initialValues(fields);
  for (const field of fields) {
    const value = data[field.key];
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') values[field.key] = value;
    } else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      values[field.key] = String(value);
    }
  }
  return values;
}

/** Values for a changed set of fields: what was typed is kept for a field whose key and kind are the same. */
export function carryOver(fields: CaptureField[], current: FormValues): FormValues {
  const next = initialValues(fields);
  for (const key of Object.keys(next)) {
    if (key in current && typeof current[key] === typeof next[key]) next[key] = current[key] as string | boolean;
  }
  return next;
}
