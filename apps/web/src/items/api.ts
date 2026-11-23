// The SPA's calls to the item and process routes (GWP#5, docs/process.md). A step's complete or retry,
// an item's resume (GWP#22), a data edit (GWP#23) and a cancel (GWP#54) send the rowVersion the view last read; a stale one is 409, answered as
// a form-level error.

import type { CompleteStepRequest, DeliveryResponse, ItemDetailResponse, ItemPage } from '@getworkdone/contracts';
import { read, write, type WriteResult } from '../work-types/api.js';

const itemPath = (teamId: string, itemId: string) => `/api/v1/teams/${encodeURIComponent(teamId)}/items/${encodeURIComponent(itemId)}`;
const stepPath = (teamId: string, itemId: string, stepId: string) => `${itemPath(teamId, itemId)}/steps/${encodeURIComponent(stepId)}`;

/**
 * A page of the items waiting for the signed-in member (GWP#55): `in_progress` at a human step whose role
 * they hold, across the team's work types, newest first; pass the last page's `nextCursor` for the next.
 */
export function listWaitingItems(teamId: string, { cursor }: { cursor?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<ItemPage> {
  const params = new URLSearchParams({ waiting: 'me' });
  if (cursor !== undefined) params.set('cursor', cursor);
  return read(`/api/v1/teams/${encodeURIComponent(teamId)}/items?${params.toString()}`, fetchImpl);
}

export function getItem(teamId: string, itemId: string, fetchImpl: typeof fetch = fetch): Promise<ItemDetailResponse> {
  return read(itemPath(teamId, itemId), fetchImpl);
}

/** The item's email and webhook deliveries (GWP#6, docs/outputs.md). */
export function getDeliveries(teamId: string, itemId: string, fetchImpl: typeof fetch = fetch): Promise<DeliveryResponse[]> {
  return read(`${itemPath(teamId, itemId)}/deliveries`, fetchImpl);
}

/** Completes a human step: the rowVersion, and the decision and comment when given (GWP#54). */
export function completeStep(teamId: string, itemId: string, stepId: string, body: CompleteStepRequest, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ItemDetailResponse>> {
  return write(`${stepPath(teamId, itemId, stepId)}/complete`, body, csrfToken, fetchImpl);
}

export function retryStep(teamId: string, itemId: string, stepId: string, rowVersion: number, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ItemDetailResponse>> {
  return write(`${stepPath(teamId, itemId, stepId)}/retry`, { rowVersion }, csrfToken, fetchImpl);
}

/** Resumes an item whose processing stopped between transitions (GWP#22; admins). */
export function resumeItem(teamId: string, itemId: string, rowVersion: number, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ItemDetailResponse>> {
  return write(`${itemPath(teamId, itemId)}/advance`, { rowVersion }, csrfToken, fetchImpl);
}

/** Cancels an item that has not completed, with the reason when given (GWP#54; admins). */
export function cancelItem(teamId: string, itemId: string, rowVersion: number, reason: string | undefined, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ItemDetailResponse>> {
  return write(`${itemPath(teamId, itemId)}/cancel`, reason === undefined ? { rowVersion } : { rowVersion, reason }, csrfToken, fetchImpl);
}

/** Replaces the data of a failed item, or of one waiting at a human step (GWP#23; admins); a 422 keeps its field errors. */
export function editItemData(teamId: string, itemId: string, rowVersion: number, data: Record<string, unknown>, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<ItemDetailResponse>> {
  return write(`${itemPath(teamId, itemId)}/data`, { rowVersion, data }, csrfToken, fetchImpl);
}
