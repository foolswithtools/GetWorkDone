// What the process engine does next with an item (GWP#5, docs/process.md). Pure: it reads the item's
// status, its current step index and the type of its last ItemEvent, which every transition writes in
// the same transaction as the item's update, so the three always agree.
//
//   - `step_started` is the last event while the current step runs: an automated step is then run, a
//     human step waits for its completion;
//   - any other last event means the current step has not started yet: it is started, or, past the
//     last step, the item is completed.
import type { ItemStatus, ProcessStep } from '@getworkdone/contracts';

export type NextAction =
  | { kind: 'start'; index: number }
  | { kind: 'run'; index: number }
  | { kind: 'wait'; index: number }
  | { kind: 'complete' }
  | { kind: 'stop' };

export function nextAction(steps: readonly ProcessStep[], item: { status: ItemStatus; currentStepIndex: number }, lastEventType: string | undefined): NextAction {
  if (item.status !== 'open' && item.status !== 'in_progress') return { kind: 'stop' };
  const index = item.currentStepIndex;
  if (lastEventType === 'step_started') {
    const step = steps[index];
    if (!step) return { kind: 'stop' };
    return step.kind === 'automated' ? { kind: 'run', index } : { kind: 'wait', index };
  }
  return index < steps.length ? { kind: 'start', index } : { kind: 'complete' };
}
