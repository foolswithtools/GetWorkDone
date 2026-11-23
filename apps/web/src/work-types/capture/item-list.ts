// Decisions the capture page makes about the version it shows and the items it lists (GWP#21,
// docs/capture.md). Plain functions, so they are unit tested without rendering the page.

import { FORM_ERROR_KEY, type CaptureErrors, type CaptureField } from '@getworkdone/contracts';

/**
 * Whether the API's errors name keys the form does not know: a key that is not one of its fields, or one
 * of its fields called unknown. The form checked the same data with the same validator before sending,
 * so such errors mean the API validated against a newer version than the page loaded.
 */
export function namesUnknownKeys(fields: CaptureField[], errors: CaptureErrors): boolean {
  const known = new Set(fields.map((f) => f.key));
  return Object.entries(errors).some(([key, messages]) => (key !== FORM_ERROR_KEY && !known.has(key)) || messages.includes('Unknown field'));
}

/** The data keys of listed items that the current fields do not have (captured under older versions), in the order first seen. */
export function olderKeys(fields: CaptureField[], items: { data: Record<string, unknown> }[]): string[] {
  const known = new Set(fields.map((f) => f.key));
  const older = new Set<string>();
  for (const item of items) for (const key of Object.keys(item.data)) if (!known.has(key)) older.add(key);
  return [...older];
}
