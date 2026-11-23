import type { WorkTypeDefinition } from '@getworkdone/contracts';

export function definition(label = 'Title'): WorkTypeDefinition {
  return {
    fields: [{ key: 'title', label, type: 'text', required: true }],
    steps: [{ id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' }],
    outputs: [{ id: 'keep', kind: 'persist', config: {} }],
  };
}
