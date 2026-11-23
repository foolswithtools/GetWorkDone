// The export output (GWP#6, docs/outputs.md): a CSV or JSON file of a work type's completed items,
// generated when a member asks for one (exports.service.ts), never per item. CSV columns are item_id,
// completed_at, then the fields in the definition's order. A text cell that a spreadsheet would read as
// a formula (starting with =, +, -, @, tab or carriage return) is written with a leading apostrophe.
import { MAX_EXPORT_BYTES, type CaptureField, type ExportFormat } from '@getworkdone/contracts';
import type { CompletedItem, DeliveryContext, DeliveryResult, OutputAdapter } from './output-adapter.js';

/** One completed item as exported. */
export interface ExportRow {
  id: string;
  completedAt: string;
  data: Record<string, unknown>;
}

/** The export would pass `limit` bytes. */
export class ExportTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`This export would be larger than ${limit / (1024 * 1024)} MB`);
  }
}

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Collects an export's text, refusing to grow past `limit` bytes. */
export class ExportBuilder {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private count = 0;
  private started = false;

  constructor(readonly format: ExportFormat, private readonly fields: readonly CaptureField[], private readonly limit = MAX_EXPORT_BYTES) {
    if (format === 'csv') this.push(`${['item_id', 'completed_at', ...fields.map((f) => f.key)].map(csvCell).join(',')}\r\n`);
    else this.push('[');
  }

  add(row: ExportRow): void {
    if (this.format === 'csv') {
      this.push(`${[row.id, row.completedAt, ...this.fields.map((f) => row.data[f.key])].map(csvCell).join(',')}\r\n`);
    } else {
      this.push(`${this.started ? ',' : ''}${JSON.stringify({ id: row.id, completedAt: row.completedAt, data: row.data })}`);
      this.started = true;
    }
    this.count += 1;
  }

  /** The finished file and how many items it holds. */
  finish(): { content: Buffer; itemCount: number } {
    if (this.format === 'json') this.push(']');
    return { content: Buffer.from(this.chunks.join(''), 'utf8'), itemCount: this.count };
  }

  private push(text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > this.limit) throw new ExportTooLarge(this.limit);
    this.chunks.push(text);
  }
}

/**
 * The adapter for `export` outputs. Nothing is sent when an item completes: the item is in the next
 * export a member asks for, so delivery succeeds at once and no Delivery row is written for it.
 */
export class ExportAdapter implements OutputAdapter {
  readonly kind = 'export' as const;

  async deliver(_item: CompletedItem, _config: unknown, _ctx: DeliveryContext): Promise<DeliveryResult> {
    return { status: 'delivered' };
  }
}
