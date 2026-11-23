import type { CaptureField } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { namesUnknownKeys, olderKeys } from './item-list.js';

const fields: CaptureField[] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false },
];

// GWP#21: the capture page validates against the version it loaded, which may no longer be the latest.
describe('namesUnknownKeys', () => {
  it('is false for errors on the form\'s own fields or the form as a whole', () => {
    expect(namesUnknownKeys(fields, { title: ['Required'], _form: ['The server answered 500'] })).toBe(false);
    expect(namesUnknownKeys(fields, {})).toBe(false);
  });

  it('is true for an error on a key the form does not have, such as a field a newer version added', () => {
    expect(namesUnknownKeys(fields, { urgent: ['Required'] })).toBe(true);
  });

  it('is true when the server calls one of the form\'s fields unknown, because a newer version removed it', () => {
    expect(namesUnknownKeys(fields, { amount: ['Unknown field'] })).toBe(true);
  });
});

describe('olderKeys', () => {
  it('lists the data keys of items that the current fields do not have, in the order first seen', () => {
    const items = [{ data: { title: 'a', colour: 'red' } }, { data: { title: 'b', size: 2, colour: 'blue' } }, { data: { amount: 1 } }];
    expect(olderKeys(fields, items)).toEqual(['colour', 'size']);
  });

  it('is empty when every item was captured under the current fields', () => {
    expect(olderKeys(fields, [{ data: { title: 'a' } }])).toEqual([]);
  });
});
