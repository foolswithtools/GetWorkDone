import type { ItemDetailResponse } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { canCancel, canComplete, canEditData, canResume, canRetry, completionBody, decisionInput, eventSummary, stepStates } from './model.js';

const steps: ItemDetailResponse['steps'] = [
  { id: 'up', name: 'Upper', kind: 'automated', transform: 'string_case', params: {} },
  { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' },
  { id: 'boss', name: 'Sign-off', kind: 'human', assigneeRole: 'admin' },
];

/** An item; an `in_progress` one's last event is `step_started` unless `last` says otherwise. */
function item(status: ItemDetailResponse['status'], currentStepIndex: number, last = status === 'in_progress' ? 'step_started' : 'captured'): ItemDetailResponse {
  const events = [{ seq: 1, type: 'captured', actorSubject: 'x', at: 'a', payload: {} }, ...(last === 'captured' ? [] : [{ seq: 2, type: last, actorSubject: null, at: 'a', payload: {} }])];
  return { id: 'i', teamId: 't', workTypeVersionId: 'v', data: {}, status, currentStepIndex, rowVersion: 1, createdAt: 'c', updatedAt: 'u', events, steps, fields: [] };
}

describe('stepStates', () => {
  it('steps before the current one are done; the current one waits for its role or runs; later ones are pending', () => {
    expect(stepStates(item('in_progress', 1)).map((s) => s.label)).toEqual(['done', 'waiting for a member', 'pending']);
    expect(stepStates(item('in_progress', 2)).map((s) => s.label)).toEqual(['done', 'done', 'waiting for an admin']);
    expect(stepStates(item('in_progress', 0)).map((s) => s.label)).toEqual(['running', 'pending', 'pending']);
    expect(stepStates(item('open', 0)).map((s) => s.label)).toEqual(['pending', 'pending', 'pending']);
  });

  it('a failed item shows its current step failed; a completed one shows every step done', () => {
    expect(stepStates(item('failed', 0)).map((s) => s.state)).toEqual(['failed', 'pending', 'pending']);
    expect(stepStates(item('completed', 3)).map((s) => s.state)).toEqual(['done', 'done', 'done']);
  });
});

describe('who may act', () => {
  it('a waiting human step is completed by its role; an admin may complete a member step', () => {
    expect(canComplete(item('in_progress', 1), 1, 'member')).toBe(true);
    expect(canComplete(item('in_progress', 1), 1, 'admin')).toBe(true);
    expect(canComplete(item('in_progress', 2), 2, 'member')).toBe(false);
    expect(canComplete(item('in_progress', 2), 2, 'admin')).toBe(true);
    expect(canComplete(item('in_progress', 2), 1, 'admin')).toBe(false);
  });

  it('only an admin retries, and only the failed step', () => {
    expect(canRetry(item('failed', 0), 0, 'admin')).toBe(true);
    expect(canRetry(item('failed', 0), 0, 'member')).toBe(false);
    expect(canRetry(item('failed', 0), 1, 'admin')).toBe(false);
    expect(canRetry(item('in_progress', 0), 0, 'admin')).toBe(false);
  });
});

// GWP#22: an item whose processing stopped between transitions, and the human step it never started.
describe('resume', () => {
  it('an admin may resume an open item, or one in progress that is not waiting at a started human step', () => {
    expect(canResume(item('open', 0), 'admin')).toBe(true);
    expect(canResume(item('in_progress', 0), 'admin')).toBe(true);
    expect(canResume(item('in_progress', 0, 'step_completed'), 'admin')).toBe(true);
    expect(canResume(item('in_progress', 1, 'step_completed'), 'admin')).toBe(true);
    expect(canResume(item('in_progress', 3, 'step_completed'), 'admin')).toBe(true);
  });

  it('not a member, not an item waiting at a human step, and not a failed or completed one', () => {
    expect(canResume(item('open', 0), 'member')).toBe(false);
    expect(canResume(item('in_progress', 1), 'admin')).toBe(false);
    expect(canResume(item('failed', 0), 'admin')).toBe(false);
    expect(canResume(item('completed', 3), 'admin')).toBe(false);
    // A started step the version does not have: the engine stops rather than guess.
    expect(canResume(item('in_progress', 3), 'admin')).toBe(false);
  });

  it('a human step the item reached but never started is pending, and cannot be completed until it is resumed', () => {
    const stopped = item('in_progress', 1, 'step_completed');
    expect(stepStates(stopped).map((s) => s.label)).toEqual(['done', 'pending', 'pending']);
    expect(canComplete(stopped, 1, 'admin')).toBe(false);
  });
});

// GWP#23: an admin corrects the data of a failed item, or of one waiting at a human step.
describe('edit data', () => {
  /** An item whose last event, after its own, is an admin's data edit. */
  const edited = (base: ItemDetailResponse): ItemDetailResponse => ({ ...base, events: [...base.events, { seq: 9, type: 'data_edited', actorSubject: 'x', at: 'a', payload: { fields: ['title'] } }] });

  it('an admin may edit a failed item, or one waiting at a human step; nothing else, and never a member', () => {
    expect(canEditData(item('failed', 0), 'admin')).toBe(true);
    expect(canEditData(item('in_progress', 1), 'admin')).toBe(true);
    expect(canEditData(item('in_progress', 2), 'admin')).toBe(true);
    expect(canEditData(item('failed', 0), 'member')).toBe(false);
    expect(canEditData(item('in_progress', 1), 'member')).toBe(false);
    expect(canEditData(item('in_progress', 0), 'admin')).toBe(false);
    expect(canEditData(item('in_progress', 1, 'step_completed'), 'admin')).toBe(false);
    expect(canEditData(item('open', 0), 'admin')).toBe(false);
    expect(canEditData(item('completed', 3), 'admin')).toBe(false);
  });

  it('an edit moves no step: a waiting step still waits, can be completed and the item is not offered Resume', () => {
    const waiting = edited(item('in_progress', 1));
    expect(stepStates(waiting).map((s) => s.label)).toEqual(['done', 'waiting for a member', 'pending']);
    expect(canComplete(waiting, 1, 'member')).toBe(true);
    expect(canResume(waiting, 'admin')).toBe(false);
    expect(canEditData(waiting, 'admin')).toBe(true);
    const failed = edited(item('failed', 0));
    expect(canRetry(failed, 0, 'admin')).toBe(true);
    expect(canEditData(failed, 'admin')).toBe(true);
  });
});

describe('eventSummary', () => {
  it('names the step, a retry and a failure\'s reason and errors', () => {
    expect(eventSummary({ seq: 2, type: 'step_started', actorSubject: null, at: 'a', payload: { stepId: 'up', stepIndex: 0 } }, steps)).toBe('Upper');
    expect(eventSummary({ seq: 3, type: 'step_started', actorSubject: 'x', at: 'a', payload: { stepId: 'up', retry: true } }, steps)).toBe('Upper (retry)');
    expect(eventSummary({ seq: 4, type: 'step_failed', actorSubject: null, at: 'a', payload: { stepId: 'up', reason: 'Bad', errors: { title: ['Required'] } } }, steps)).toBe('Upper: Bad (title: Required)');
    expect(eventSummary({ seq: 5, type: 'step_completed', actorSubject: null, at: 'a', payload: { stepId: 'gone' } }, steps)).toBe('gone');
    expect(eventSummary({ seq: 1, type: 'captured', actorSubject: 'x', at: 'a', payload: { workTypeVersionId: 'v' } }, steps)).toBe('');
  });

  it('names a failed delivery\'s output, reason and attempts, and a completion that cleared the data (GWP#6)', () => {
    expect(eventSummary({ seq: 3, type: 'delivery_failed', actorSubject: null, at: 'a', payload: { outputId: 'hook', kind: 'webhook', attempts: 3, reason: 'http_503' } }, steps)).toBe('webhook output hook: http_503 after 3 attempts');
    expect(eventSummary({ seq: 3, type: 'delivery_failed', actorSubject: null, at: 'a', payload: { outputId: 'meta', kind: 'webhook', attempts: 1, reason: 'blocked_address' } }, steps)).toBe('webhook output meta: blocked_address after 1 attempt');
    expect(eventSummary({ seq: 2, type: 'completed', actorSubject: 'x', at: 'a', payload: { dataCleared: true } }, steps)).toBe('captured data cleared (output none)');
  });

  it('names the fields a data edit changed (GWP#23)', () => {
    expect(eventSummary({ seq: 4, type: 'data_edited', actorSubject: 'x', at: 'a', payload: { fields: ['reference', 'title'] } }, steps)).toBe('fields changed: reference, title');
  });

  it('shows a cancel\'s reason, and a completion\'s decision and comment (GWP#54)', () => {
    expect(eventSummary({ seq: 4, type: 'cancelled', actorSubject: 'x', at: 'a', payload: { reason: 'captured twice' } }, steps)).toBe('reason: captured twice');
    expect(eventSummary({ seq: 4, type: 'cancelled', actorSubject: 'x', at: 'a', payload: {} }, steps)).toBe('');
    expect(eventSummary({ seq: 5, type: 'step_completed', actorSubject: 'x', at: 'a', payload: { stepId: 'review', decision: 'approve', comment: 'ok' } }, steps)).toBe('Review (decision: approve; comment: ok)');
    expect(eventSummary({ seq: 5, type: 'step_completed', actorSubject: 'x', at: 'a', payload: { stepId: 'review', decision: 'approve' } }, steps)).toBe('Review (decision: approve)');
    expect(eventSummary({ seq: 5, type: 'step_completed', actorSubject: 'x', at: 'a', payload: { stepId: 'review', comment: 'see notes' } }, steps)).toBe('Review (comment: see notes)');
  });
});

// GWP#54: an admin cancels an item that has not completed; a human step's completion carries a decision and a comment.
describe('cancel', () => {
  it('an admin may cancel an open, in-progress (waiting or not) or failed item; never a member, nor a completed or cancelled item', () => {
    for (const it of [item('open', 0), item('in_progress', 1), item('in_progress', 0), item('failed', 0)]) expect(canCancel(it, 'admin'), it.status).toBe(true);
    expect(canCancel(item('in_progress', 1), 'member')).toBe(false);
    expect(canCancel(item('completed', 3), 'admin')).toBe(false);
    expect(canCancel(item('cancelled', 1, 'cancelled'), 'admin')).toBe(false);
  });

  it('a cancelled item offers nothing else, and its current step reads cancelled', () => {
    const cancelled = item('cancelled', 1, 'cancelled');
    expect(stepStates(cancelled).map((s) => s.label)).toEqual(['done', 'cancelled', 'pending']);
    expect([canComplete(cancelled, 1, 'admin'), canRetry(cancelled, 1, 'admin'), canResume(cancelled, 'admin'), canEditData(cancelled, 'admin')]).toEqual([false, false, false, false]);
  });
});

describe('completing a human step with a decision', () => {
  const approve = { id: 'approve', name: 'Approve', kind: 'human', assigneeRole: 'member', decisions: ['approve', 'reject'] } as const;
  const review = steps[1]!;

  it('a step with decisions yields a select of them; one without, a text input', () => {
    expect(decisionInput({ ...approve, decisions: [...approve.decisions] })).toEqual({ kind: 'select', options: ['approve', 'reject'] });
    expect(decisionInput(review)).toEqual({ kind: 'text' });
  });

  it('maps the form\'s state to the request body: the rowVersion, the decision and the comment when given', () => {
    expect(completionBody(4, { decision: 'approve', comment: 'ok' })).toEqual({ rowVersion: 4, decision: 'approve', comment: 'ok' });
    expect(completionBody(4, { decision: '', comment: '' })).toEqual({ rowVersion: 4 });
    // Free text is trimmed; only spaces is no decision. A comment is sent as typed unless blank.
    expect(completionBody(2, { decision: '  looks fine  ', comment: '  ' })).toEqual({ rowVersion: 2, decision: 'looks fine' });
    expect(completionBody(2, { decision: '   ', comment: ' see notes ' })).toEqual({ rowVersion: 2, comment: ' see notes ' });
  });
});
