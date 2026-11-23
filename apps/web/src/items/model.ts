// The item view's reading of an item (GWP#5, docs/process.md): each step's state from the item's status,
// current step index and last event, who may complete or retry a step, resume the item (GWP#22), edit
// its data (GWP#23) or cancel it (GWP#54), what a human step's completion form sends (GWP#54), and a line
// of detail for each event. The server decides; these only choose what the view offers.

import type { CompleteStepRequest, ItemDetailResponse, ItemEventResponse, ProcessStep, TeamRole } from '@getworkdone/contracts';

export type StepState = 'done' | 'running' | 'waiting' | 'failed' | 'cancelled' | 'pending';

const article = (role: TeamRole) => (role === 'admin' ? 'an admin' : 'a member');

/**
 * Whether the item's current step has started: its last transition event is `step_started`, as the engine
 * reads it. An admin's `data_edited` (GWP#23) moves no step, so it is passed over.
 */
const started = (item: ItemDetailResponse) => item.events.filter((e) => e.type !== 'data_edited').at(-1)?.type === 'step_started';

function stateOf(item: ItemDetailResponse, step: ProcessStep, index: number): StepState {
  if (item.status === 'completed' || index < item.currentStepIndex) return 'done';
  if (index > item.currentStepIndex) return 'pending';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'cancelled') return 'cancelled';
  if (item.status !== 'in_progress') return 'pending';
  if (step.kind === 'automated') return 'running';
  // A human step the item reached but never started (its request stopped, GWP#22) waits for a resume.
  return started(item) ? 'waiting' : 'pending';
}

/** Every step of the item's version with its state and the words the view shows for it. */
export function stepStates(item: ItemDetailResponse): { step: ProcessStep; state: StepState; label: string }[] {
  return item.steps.map((step, index) => {
    const state = stateOf(item, step, index);
    const label = state === 'waiting' && step.kind === 'human' ? `waiting for ${article(step.assigneeRole)}` : state;
    return { step, state, label };
  });
}

/** Whether `role` may complete the step at `index`: it is waiting, and an admin holds `member` too. */
export function canComplete(item: ItemDetailResponse, index: number, role: TeamRole): boolean {
  const step = item.steps[index];
  if (!step || step.kind !== 'human' || stateOf(item, step, index) !== 'waiting') return false;
  return step.assigneeRole === 'member' || role === 'admin';
}

/** Whether `role` may retry the step at `index`: the item failed there, and only admins retry. */
export function canRetry(item: ItemDetailResponse, index: number, role: TeamRole): boolean {
  return role === 'admin' && item.status === 'failed' && item.currentStepIndex === index;
}

/**
 * Whether `role` may resume the item (GWP#22): only admins, and only an item whose processing stopped
 * between transitions, meaning `open`, or `in_progress` and not waiting at a started human step.
 */
export function canResume(item: ItemDetailResponse, role: TeamRole): boolean {
  if (role !== 'admin') return false;
  if (item.status === 'open') return true;
  if (item.status !== 'in_progress') return false;
  if (!started(item)) return true;
  // A started automated step is run; a started human step waits, and one the steps lack stops the engine.
  return item.steps[item.currentStepIndex]?.kind === 'automated';
}

/**
 * Whether `role` may edit the item's data (GWP#23): only admins, and only while the item is `failed` or
 * waiting at a started human step, so a retry or the step's completion sees the corrected data.
 */
export function canEditData(item: ItemDetailResponse, role: TeamRole): boolean {
  if (role !== 'admin') return false;
  if (item.status === 'failed') return true;
  const step = item.steps[item.currentStepIndex];
  return item.status === 'in_progress' && step?.kind === 'human' && started(item);
}

/**
 * Whether `role` may cancel the item (GWP#54): only admins, and only while it can still move, meaning
 * `open`, `in_progress` (waiting at a human step or not) or `failed`.
 */
export function canCancel(item: ItemDetailResponse, role: TeamRole): boolean {
  return role === 'admin' && (item.status === 'open' || item.status === 'in_progress' || item.status === 'failed');
}

/** How a human step's completion asks for a decision (GWP#54): a select of the step's decisions, or free text. */
export type DecisionInput = { kind: 'select'; options: string[] } | { kind: 'text' };

export function decisionInput(step: ProcessStep): DecisionInput {
  return step.kind === 'human' && step.decisions ? { kind: 'select', options: step.decisions } : { kind: 'text' };
}

/** What the completion form beside a Complete button holds, as typed or chosen. */
export interface CompletionForm { decision: string; comment: string }

/**
 * The completion request for the form (GWP#54): the rowVersion the view read, the decision trimmed and
 * the comment as typed, each left out when blank. A step that lists decisions refuses a missing one
 * (422 keyed `decision`), which the view shows.
 */
export function completionBody(rowVersion: number, form: CompletionForm): CompleteStepRequest {
  const decision = form.decision.trim();
  return { rowVersion, ...(decision !== '' ? { decision } : {}), ...(form.comment.trim() !== '' ? { comment: form.comment } : {}) };
}

/**
 * The step an event is about, by name, with a retry, a failure's reason and errors, or a completion's
 * decision and comment (GWP#54); a cancel's reason.
 */
export function eventSummary(event: ItemEventResponse, steps: ProcessStep[]): string {
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  // GWP#6: a delivery that gave up, and a completion that cleared the data (output none, D-048).
  if (event.type === 'delivery_failed') {
    const attempts = Number(payload.attempts);
    return `${String(payload.kind)} output ${String(payload.outputId)}: ${String(payload.reason)} after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
  }
  if (payload.dataCleared === true) return 'captured data cleared (output none)';
  // GWP#23: an admin's data edit names the changed fields, never their values (D-048).
  if (event.type === 'data_edited' && Array.isArray(payload.fields)) return `fields changed: ${payload.fields.map(String).join(', ')}`;
  if (event.type === 'cancelled') return typeof payload.reason === 'string' ? `reason: ${payload.reason}` : '';
  if (typeof payload.stepId !== 'string') return '';
  const name = steps.find((s) => s.id === payload.stepId)?.name || payload.stepId;
  if (payload.retry === true) return `${name} (retry)`;
  if (event.type === 'step_completed' && (typeof payload.decision === 'string' || typeof payload.comment === 'string')) {
    const parts = [typeof payload.decision === 'string' ? `decision: ${payload.decision}` : '', typeof payload.comment === 'string' ? `comment: ${payload.comment}` : ''];
    return `${name} (${parts.filter(Boolean).join('; ')})`;
  }
  if (typeof payload.reason !== 'string') return name;
  const errors = typeof payload.errors === 'object' && payload.errors !== null ? Object.entries(payload.errors as Record<string, string[]>) : [];
  const detail = errors.map(([key, messages]) => `${key}: ${messages.join(', ')}`).join('; ');
  return detail ? `${name}: ${payload.reason} (${detail})` : `${name}: ${payload.reason}`;
}
