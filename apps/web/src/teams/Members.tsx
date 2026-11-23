import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { TeamMemberResponse, TeamRole } from '@getworkdone/contracts';
import { addMember, listMembers, removeMember } from './api.js';

/**
 * A team's members, for its admins (GWP#20, docs/auth.md "Team membership"): add someone by the subject
 * their identity provider gives them, with a role, or remove a member. Each row leads with the member's
 * display name, else their email, as of their last sign-in, else the subject; the subject stays on the
 * row beside a name or email so it can still be copied (GWP#99). The API refuses a subject already
 * in the team and the removal of the last admin; the panel shows its message. An admin who removes
 * themself (`subject`) has left the team: `onLeft` takes them back to their teams.
 */
export function Members({ teamId, subject: self, csrfToken, onLeft }: { teamId: string; subject: string; csrfToken: string; onLeft: () => void }) {
  const [members, setMembers] = useState<TeamMemberResponse[] | 'error' | undefined>();
  const [subject, setSubject] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const refresh = useCallback(() => {
    listMembers(teamId).then(setMembers).catch(() => setMembers('error'));
  }, [teamId]);
  useEffect(refresh, [refresh]);

  async function run(write: () => Promise<{ ok: true } | { ok: false; errors: Record<string, string[]> }>, onDone?: () => void, left = false) {
    setBusy(true);
    setMessage(undefined);
    const result = await write();
    setBusy(false);
    if (result.ok && left) onLeft();
    else if (result.ok) {
      onDone?.();
      refresh();
    } else setMessage(Object.values(result.errors).flat().join(' ') || 'The change failed');
  }

  function add(event: FormEvent) {
    event.preventDefault();
    void run(() => addMember(teamId, { subject: subject.trim(), role }, csrfToken), () => setSubject(''));
  }

  return (
    <section aria-labelledby="members-title" data-testid="members-panel">
      <h3 id="members-title">Members</h3>
      {members === undefined && <p>Loading members…</p>}
      {members === 'error' && <p role="alert">Could not load the members.</p>}
      {Array.isArray(members) && (
        <ul data-testid="member-list">
          {members.map((m) => (
            <li key={m.subject} data-testid="member-row">
              {m.displayName ?? m.email
                ? <><span data-testid="member-name">{m.displayName ?? m.email}</span> <code data-testid="member-subject">{m.subject}</code></>
                : <code data-testid="member-subject">{m.subject}</code>} {m.role}{' '}
              <button type="button" disabled={busy} onClick={() => void run(() => removeMember(teamId, m.subject, csrfToken), undefined, m.subject === self)} aria-label={`Remove ${m.subject}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add}>
        <p>
          <label htmlFor="member-subject">Subject (from their "Signed in as" header)</label>{' '}
          <input id="member-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={255} autoComplete="off" />{' '}
          <label htmlFor="member-role">Role</label>{' '}
          <select id="member-role" value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>{' '}
          <button type="submit" disabled={busy || subject.trim() === ''} data-testid="members-add">Add member</button>
        </p>
        <p>The subject is the person's identifier at the identity provider (the OIDC <code>sub</code>), not their email address. They find it in their own header after signing in, on the "Signed in as" line beside their email, with a Copy subject button. Once they have signed in, the list shows their name.</p>
      </form>
      {message && <p role="alert" data-testid="members-error">{message}</p>}
    </section>
  );
}
