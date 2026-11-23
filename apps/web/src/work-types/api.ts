// The SPA's calls to the work type and capture routes (GWP#4, docs/capture.md); read and write are
// shared with the item calls (items/api.ts). Reads throw on an error
// status. Writes answer either the created value or errors keyed like CaptureErrors: a 422 carries
// them as `{ errors }` (every invalid definition, GWP#21); a 400 lists `issues` with dotted paths (a
// malformed item body); anything else is one form-level message.

import { FORM_ERROR_KEY, type CaptureErrors, type ExportFormat, type ExportResponse, type ItemDetailResponse, type ItemPage, type ItemStatus, type WorkTypeDefinition, type WorkTypeResponse } from '@getworkdone/contracts';
import { CSRF_HEADER } from '../auth/api.js';
import { tracedFetch } from '../traced-fetch.js';

/** A refused write; a 429 with a `Retry-After` in seconds also says how long to wait (GWP#35). */
export type WriteResult<T> = { ok: true; value: T } | { ok: false; errors: CaptureErrors; retryAfterSeconds?: number };

const teamPath = (teamId: string) => `/api/v1/teams/${encodeURIComponent(teamId)}/work-types`;
const workTypePath = (teamId: string, workTypeId: string) => `${teamPath(teamId)}/${encodeURIComponent(workTypeId)}`;

export async function read<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await tracedFetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }, fetchImpl);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return await res.json() as T;
}

/** The errors in a failed write's body. */
function errorsFrom(status: number, body: unknown): CaptureErrors {
  const object = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  if (typeof object.errors === 'object' && object.errors !== null) return object.errors as CaptureErrors;
  if (Array.isArray(object.issues)) {
    const errors: CaptureErrors = {};
    for (const issue of object.issues as { path: string; message: string }[]) (errors[issue.path || FORM_ERROR_KEY] ??= []).push(issue.message);
    return errors;
  }
  return { [FORM_ERROR_KEY]: [typeof object.message === 'string' ? object.message : `The server answered ${status}`] };
}

/** A 429's `Retry-After` when it is a whole number of seconds above 0; the HTTP-date form is not used by this API. */
function retryAfterFrom(res: Response): number | undefined {
  const header = res.status === 429 ? res.headers.get('retry-after')?.trim() : undefined;
  return header && /^\d+$/.test(header) && Number(header) > 0 ? Number(header) : undefined;
}

async function send<T>(init: RequestInit & { headers: Record<string, string> }, path: string, csrfToken: string, fetchImpl: typeof fetch): Promise<WriteResult<T>> {
  const res = await tracedFetch(path, { ...init, credentials: 'same-origin', headers: { accept: 'application/json', ...init.headers, [CSRF_HEADER]: csrfToken } }, fetchImpl);
  const parsed: unknown = await res.json().catch(() => undefined);
  if (res.ok) return { ok: true, value: parsed as T };
  const retryAfterSeconds = retryAfterFrom(res);
  return { ok: false, errors: errorsFrom(res.status, parsed), ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}

export function write<T>(path: string, body: unknown, csrfToken: string, fetchImpl: typeof fetch): Promise<WriteResult<T>> {
  return send({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, path, csrfToken, fetchImpl);
}

/** A DELETE with the CSRF header (GWP#20); a 204 is `{ ok: true, value: undefined }`. */
export function remove(path: string, csrfToken: string, fetchImpl: typeof fetch): Promise<WriteResult<undefined>> {
  return send({ method: 'DELETE', headers: {} }, path, csrfToken, fetchImpl);
}

/** The team's work types, archived ones included (GWP#55): the team page lists those apart, and a capture page open on one still reloads it. */
export function listWorkTypes(teamId: string, fetchImpl: typeof fetch = fetch): Promise<WorkTypeResponse[]> {
  return read(`${teamPath(teamId)}?includeArchived=true`, fetchImpl);
}

/** Archives a work type, or unarchives it (GWP#55; admins): while archived it takes no new items or versions. */
export function archiveWorkType(teamId: string, workTypeId: string, archived: boolean, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<WorkTypeResponse>> {
  return write(`${workTypePath(teamId, workTypeId)}/${archived ? 'archive' : 'unarchive'}`, {}, csrfToken, fetchImpl);
}

/** One work type with its latest version, read afresh (there is no single-work-type route). */
export async function getWorkType(teamId: string, workTypeId: string, fetchImpl: typeof fetch = fetch): Promise<WorkTypeResponse> {
  const found = (await listWorkTypes(teamId, fetchImpl)).find((wt) => wt.id === workTypeId);
  if (!found) throw new Error(`Work type ${workTypeId} not found`);
  return found;
}

/**
 * A page of the work type's items, newest first; pass the last page's `nextCursor` for the next (GWP#21),
 * and a status to list only those (GWP#54), with the same status for every page of that list.
 */
export function listItems(teamId: string, workTypeId: string, { cursor, status }: { cursor?: string; status?: ItemStatus } = {}, fetchImpl: typeof fetch = fetch): Promise<ItemPage> {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set('cursor', cursor);
  if (status !== undefined) params.set('status', status);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return read(`${workTypePath(teamId, workTypeId)}/items${query}`, fetchImpl);
}

export function createWorkType(teamId: string, slug: string, definition: WorkTypeDefinition, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<WorkTypeResponse>> {
  return write(teamPath(teamId), { slug, definition }, csrfToken, fetchImpl);
}

export function addVersion(teamId: string, workTypeId: string, definition: WorkTypeDefinition, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<WorkTypeResponse>> {
  return write(`${workTypePath(teamId, workTypeId)}/versions`, { definition }, csrfToken, fetchImpl);
}

export function submitItem(teamId: string, workTypeId: string, data: Record<string, unknown>, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ItemDetailResponse>> {
  return write(`${workTypePath(teamId, workTypeId)}/items`, { data }, csrfToken, fetchImpl);
}

/** Generate an export of the work type's completed items (GWP#6, docs/outputs.md). */
export function createExport(teamId: string, workTypeId: string, format: ExportFormat, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ExportResponse>> {
  return write(`${workTypePath(teamId, workTypeId)}/exports`, { format }, csrfToken, fetchImpl);
}

export function listExports(teamId: string, workTypeId: string, fetchImpl: typeof fetch = fetch): Promise<ExportResponse[]> {
  return read(`${workTypePath(teamId, workTypeId)}/exports`, fetchImpl);
}

/** Where an export downloads from: a plain link, so the browser saves the file with the session cookie. */
export function exportDownloadPath(teamId: string, exportId: string): string {
  return `/api/v1/teams/${encodeURIComponent(teamId)}/exports/${encodeURIComponent(exportId)}/download`;
}
