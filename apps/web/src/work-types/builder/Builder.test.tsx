// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Builder } from './Builder.js';

// The builder errors on the wrong field (docs/known-issues/2026-10-21-safe-pattern-bypasses.md): the API
// keys a refused definition's errors by field position, so any edit that can move a field clears them
// (`edit` in Builder.tsx). The builder's own check runs on every render, so its errors follow the field.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A builder for a new work type, slug filled in, holding two text fields: Field 1 and Field 2. */
async function twoFields() {
  const user = userEvent.setup();
  render(<Builder teamId="team-1" csrfToken="csrf" onSaved={vi.fn()} onCancel={vi.fn()} />);
  await user.type(screen.getByLabelText('Slug'), 'requests');
  await user.click(screen.getByTestId('builder-add'));
  return user;
}

describe('Builder errors after a reorder', () => {
  it('shows a refused save\'s error beside the field it names, and on no field once a field moves', async () => {
    const refused = { errors: { 'definition.fields.1.pattern': ['Unsafe pattern'] } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(refused), { status: 422, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const user = await twoFields();

    await user.click(screen.getByTestId('builder-save'));
    expect(await screen.findByTestId('builder-field-1-pattern-error')).toHaveProperty('textContent', 'Unsafe pattern');
    expect(screen.queryByTestId('builder-field-0-pattern-error')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Move Field 2 up' }));
    expect(screen.getAllByTestId('builder-field').map((f) => (f.querySelector('legend')?.textContent ?? ''))).toEqual(['Field 1: Field 2', 'Field 2: Field 1']);
    expect(screen.queryByText('Unsafe pattern')).toBeNull();
  });

  it('keeps the builder\'s own pattern error beside its field after the field moves', async () => {
    const user = await twoFields();
    const unsafe = 'Pattern could take too long to check: a repeated group contains a repeat';
    const [, pattern] = screen.getAllByLabelText(/^Pattern/);
    if (!pattern) throw new Error('the second field has no pattern input');
    // `{` and `[` are user-event's key descriptors; paste the pattern in instead.
    await user.click(pattern);
    await user.paste('(a+)+$');
    expect(screen.getByTestId('builder-field-1-pattern-error')).toHaveProperty('textContent', unsafe);

    await user.click(screen.getByRole('button', { name: 'Move Field 2 up' }));
    expect(screen.getByTestId('builder-field-0-pattern-error')).toHaveProperty('textContent', unsafe);
    expect(screen.queryByTestId('builder-field-1-pattern-error')).toBeNull();
  });
});
