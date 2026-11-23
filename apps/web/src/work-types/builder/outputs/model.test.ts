import { outputProblems, type DistributionOutput, type WorkTypeDefinition } from '@getworkdone/contracts';
import { describe, expect, it } from 'vitest';
import { draftFromOutput, newOutput, outputFromDraft, removeOutput, updateOutput } from './model.js';

const fields: WorkTypeDefinition['fields'] = [{ key: 'title', label: 'Title', type: 'text', required: true }];
const problems = (outputs: DistributionOutput[]) => outputProblems({ fields, steps: [], outputs });

describe('output drafts', () => {
  it('a new output takes the first free output_N id and starts empty for its kind', () => {
    const first = newOutput([], 'webhook');
    expect(first).toMatchObject({ id: 'output_1', kind: 'webhook', url: '', deadline: '', recipients: '', subject: '', format: 'csv' });
    const second = newOutput([first, { ...first, draftId: 'x', id: 'output_3' }], 'email');
    expect(second).toMatchObject({ id: 'output_2', kind: 'email' });
    expect(second.draftId).not.toBe(first.draftId);
  });

  it('builds each kind\'s config with only the settings it takes, as outputProblems checks it', () => {
    const base = newOutput([], 'webhook');
    const webhook = outputFromDraft({ ...base, url: ' https://hooks.example.com/in ', deadline: '15000', recipients: 'ignored@example.com' });
    expect(webhook).toEqual({ id: 'output_1', kind: 'webhook', config: { url: 'https://hooks.example.com/in', deadlineMs: 15000 } });
    const email = outputFromDraft({ ...base, id: 'mail', kind: 'email', recipients: 'a@example.com\n b@example.com, ,c@example.com', subject: 'Done' });
    expect(email.config).toEqual({ recipients: ['a@example.com', 'b@example.com', 'c@example.com'], subject: 'Done' });
    expect(outputFromDraft({ ...base, kind: 'export', format: 'json' }).config).toEqual({ format: 'json' });
    expect(outputFromDraft({ ...base, kind: 'persist', url: 'x' }).config).toEqual({});
    expect(outputFromDraft({ ...base, kind: 'none' }).config).toEqual({});
    expect(problems([webhook, email])).toEqual({});
  });

  it('a deadline that is not a number is kept as NaN so the check refuses it; an empty one is left out', () => {
    const base = { ...newOutput([], 'webhook'), url: 'https://hooks.example.com/' };
    expect(outputFromDraft({ ...base, deadline: 'soon' }).config.deadlineMs).toBeNaN();
    expect(problems([outputFromDraft({ ...base, deadline: 'soon' })])).toHaveProperty(['outputs.0.config.deadlineMs']);
    expect(outputFromDraft(base).config).not.toHaveProperty('deadlineMs');
  });

  it('round-trips a stored output through a draft', () => {
    const stored: DistributionOutput[] = [
      { id: 'hook', kind: 'webhook', config: { url: 'https://hooks.example.com/', deadlineMs: 20000 } },
      { id: 'mail', kind: 'email', config: { recipients: ['a@example.com', 'b@example.com'], subject: 'S' } },
      { id: 'file', kind: 'export', config: { format: 'json' } },
      { id: 'keep', kind: 'persist', config: {} },
    ];
    expect(stored.map((o) => outputFromDraft(draftFromOutput(o)))).toEqual(stored);
    expect(draftFromOutput({ id: 'odd', kind: 'email', config: { recipients: 'not a list' } })).toMatchObject({ recipients: '' });
  });

  it('updates and removes outputs without touching the others', () => {
    const outputs = [newOutput([], 'webhook'), newOutput([], 'email')].map((o, i) => ({ ...o, id: `o${i}` }));
    expect(updateOutput(outputs, 1, { subject: 'Hi' }).map((o) => o.subject)).toEqual(['', 'Hi']);
    expect(removeOutput(outputs, 0).map((o) => o.id)).toEqual(['o1']);
  });
});
