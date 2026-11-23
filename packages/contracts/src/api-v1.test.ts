import { describe, expect, it } from 'vitest';
import { TeamMemberResponse } from './api-v1.js';

describe('TeamMemberResponse', () => {
  const member = { subject: 's', role: 'member', createdAt: '2026-11-02T00:00:00.000Z' };

  it('carries the member\'s email and display name, each null until they have signed in (GWP#99)', () => {
    expect(TeamMemberResponse.parse({ ...member, email: 'a@example.test', displayName: 'Ada' })).toEqual({ ...member, email: 'a@example.test', displayName: 'Ada' });
    expect(TeamMemberResponse.parse({ ...member, email: null, displayName: null })).toEqual({ ...member, email: null, displayName: null });
  });

  it('refuses a body without either field', () => {
    expect(TeamMemberResponse.safeParse({ ...member, displayName: null }).success).toBe(false);
    expect(TeamMemberResponse.safeParse({ ...member, email: null }).success).toBe(false);
    expect(TeamMemberResponse.safeParse(member).success).toBe(false);
  });
});
