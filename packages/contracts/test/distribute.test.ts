import { describe, expect, it } from 'vitest';
import { EmailConfig, isDeliveredKind, MAX_RECIPIENTS, MAX_RECIPIENTS_PER_ITEM, outputProblems, WebhookConfig } from '../src/distribute.js';
import type { WorkTypeDefinition } from '../src/domain.js';

function definition(outputs: unknown[]): WorkTypeDefinition {
  return { fields: [{ key: 'title', label: 'Title', type: 'text', required: true }], steps: [], outputs: outputs as WorkTypeDefinition['outputs'] };
}

describe('outputProblems', () => {
  // GWP#50: one item's email fan-out is bounded across all of a definition's email outputs.
  describe('recipients per item', () => {
    const emails = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);
    const mail = (id: string, recipients: string[]) => ({ id, kind: 'email', config: { recipients } });

    it('refuses two email outputs of 15 recipients each at `outputs`', () => {
      expect(MAX_RECIPIENTS_PER_ITEM).toBe(20);
      expect(outputProblems(definition([mail('a', emails(15, 'a')), mail('b', emails(15, 'b'))]))).toEqual({
        outputs: ['At most 20 recipients across all email outputs'],
      });
    });

    it('passes two email outputs of 10 recipients each', () => {
      expect(outputProblems(definition([mail('a', emails(10, 'a')), mail('b', emails(10, 'b')), { id: 'keep', kind: 'persist', config: {} }]))).toEqual({});
    });

    it('still refuses one output of 21 recipients by the per-output rule', () => {
      const problems = outputProblems(definition([mail('a', emails(21, 'a'))]));
      expect(problems['outputs.0.config.recipients']).toEqual([`At most ${MAX_RECIPIENTS} recipients`]);
    });
  });

  it('accepts every kind with a valid config', () => {
    expect(outputProblems(definition([
      { id: 'keep', kind: 'persist', config: {} },
      { id: 'hook', kind: 'webhook', config: { url: 'https://hooks.example.com/in', deadlineMs: 30_000 } },
      { id: 'mail', kind: 'email', config: { recipients: ['a@example.com'], subject: 'Done' } },
      { id: 'file', kind: 'export', config: { format: 'json' } },
    ]))).toEqual({});
    expect(outputProblems(definition([{ id: 'drop', kind: 'none', config: {} }]))).toEqual({});
  });

  it('saves a webhook aimed at a blocked address: blocking happens at send time', () => {
    expect(outputProblems(definition([{ id: 'meta', kind: 'webhook', config: { url: 'https://169.254.169.254/' } }]))).toEqual({});
  });

  it('refuses ids that cannot be part of an idempotency key, and duplicate ids', () => {
    expect(outputProblems(definition([
      { id: 'a:b', kind: 'persist', config: {} },
      { id: 'x', kind: 'persist', config: {} },
      { id: 'x', kind: 'export', config: {} },
    ]))).toEqual({
      'outputs.0.id': ['Use 1 to 64 letters, digits, dashes and underscores'],
      'outputs.2.id': ['Output id "x" is used twice'],
    });
  });

  it('refuses http, credentials in the URL, a deadline over 30 s, and unknown config keys', () => {
    expect(outputProblems(definition([
      { id: 'a', kind: 'webhook', config: { url: 'http://hooks.example.com/' } },
      { id: 'b', kind: 'webhook', config: { url: 'https://user:pw@hooks.example.com/' } },
      { id: 'c', kind: 'webhook', config: { url: 'https://hooks.example.com/', deadlineMs: 30_001 } },
      { id: 'd', kind: 'webhook', config: { url: 'not a url' } },
      { id: 'e', kind: 'persist', config: { extra: 1 } },
    ]))).toEqual({
      'outputs.0.config.url': ['Use an https:// URL without a user name or password'],
      'outputs.1.config.url': ['Use an https:// URL without a user name or password'],
      'outputs.2.config.deadlineMs': [expect.stringContaining('30000')],
      'outputs.3.config.url': ['Use an https:// URL without a user name or password'],
      'outputs.4.config': [expect.stringContaining('extra')],
    });
  });

  it('limits an email output to 1 to 20 valid recipients', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `r${i}@example.com`);
    expect(EmailConfig.safeParse({ recipients: many.slice(0, MAX_RECIPIENTS) }).success).toBe(true);
    expect(outputProblems(definition([
      { id: 'a', kind: 'email', config: { recipients: many } },
      { id: 'b', kind: 'email', config: { recipients: [] } },
      { id: 'c', kind: 'email', config: { recipients: ['nope'] } },
    ]))).toEqual({
      'outputs.0.config.recipients': ['At most 20 recipients'],
      'outputs.1.config.recipients': ['Add at least one recipient'],
      'outputs.2.config.recipients.0': ['Use an email address'],
      // 21 + 0 + 1 named in all: over the per-item total as well (GWP#50).
      outputs: ['At most 20 recipients across all email outputs'],
    });
  });
});

describe('the delivered kinds', () => {
  it('are email and webhook; export is on request, persist and none send nothing', () => {
    expect(['none', 'persist', 'email', 'webhook', 'export'].filter((k) => isDeliveredKind(k as never))).toEqual(['email', 'webhook']);
    expect(WebhookConfig.parse({ url: 'https://x.example.com' })).toEqual({ url: 'https://x.example.com' });
  });
});
