import { describe, expect, it } from 'vitest';
import { csvCell, ExportAdapter, ExportBuilder, ExportTooLarge } from '../src/modules/distribute/export.adapter.js';

// The export file builder (GWP#6, docs/outputs.md); the routes are in export.integration.test.ts.
const fields = [{ key: 'b', label: 'B', type: 'text' as const, required: false }, { key: 'a', label: 'A', type: 'number' as const, required: false }];

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks, and leaves the rest alone', () => {
    expect(['plain', 'a,b', 'say "hi"', 'two\nlines', 12, true, null, undefined].map(csvCell)).toEqual(['plain', '"a,b"', '"say ""hi"""', '"two\nlines"', '12', 'true', '', '']);
  });

  it('writes text a spreadsheet would run as a formula with a leading apostrophe; numbers stay numbers', () => {
    expect(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'].map(csvCell)).toEqual(["'=1+1", "'+1", "'-1", "'@SUM(A1)", "'\tx", "\"'\rx\""]);
    expect(csvCell(-1)).toBe('-1');
  });
});

describe('ExportBuilder', () => {
  it('CSV: a header in field order, then one CRLF-terminated row per item', () => {
    const builder = new ExportBuilder('csv', fields);
    builder.add({ id: 'i1', completedAt: '2026-10-21T00:00:00.000Z', data: { a: 1, b: 'x' } });
    const { content, itemCount } = builder.finish();
    expect(content.toString()).toBe('item_id,completed_at,b,a\r\ni1,2026-10-21T00:00:00.000Z,x,1\r\n');
    expect(itemCount).toBe(1);
  });

  it('JSON: an array of items; empty is []', () => {
    expect(new ExportBuilder('json', fields).finish().content.toString()).toBe('[]');
    const builder = new ExportBuilder('json', fields);
    builder.add({ id: 'i1', completedAt: 't1', data: { a: 1 } });
    builder.add({ id: 'i2', completedAt: 't2', data: {} });
    expect(JSON.parse(builder.finish().content.toString())).toEqual([{ id: 'i1', completedAt: 't1', data: { a: 1 } }, { id: 'i2', completedAt: 't2', data: {} }]);
  });

  it('refuses to grow past its limit (10 MB by default)', () => {
    const builder = new ExportBuilder('csv', fields, 64);
    builder.add({ id: 'i1', completedAt: 't', data: {} });
    expect(() => builder.add({ id: 'i2', completedAt: 't', data: { b: 'x'.repeat(64) } })).toThrow(ExportTooLarge);
    expect(new ExportTooLarge(10 * 1024 * 1024).message).toBe('This export would be larger than 10 MB');
  });
});

describe('ExportAdapter', () => {
  it('sends nothing per item: the item is in the next export', async () => {
    const adapter = new ExportAdapter();
    expect(adapter.kind).toBe('export');
    expect(await adapter.deliver({} as never, {}, { idempotencyKey: 'k', deadlineMs: 1, signal: new AbortController().signal })).toEqual({ status: 'delivered' });
  });
});
