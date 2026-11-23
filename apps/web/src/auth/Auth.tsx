import { useEffect, useState, type FormEvent } from 'react';
import { FORM_ERROR_KEY, type CaptureErrors, type MeResponse, type TeamResponse } from '@getworkdone/contracts';
import { createTeam } from '../teams/api.js';
import type { WriteResult } from '../work-types/api.js';
import { startExportWait, waitMessage } from '../work-types/capture/export-wait.js';
import { TeamWorkTypes } from '../work-types/TeamWorkTypes.js';
import { R4cWidget } from '../r4c/R4cWidget.js';
import { NotFound } from '../not-found.js';
import { browserNavigator, rememberSignInPath, takeSignInRoute, useRoute } from '../routing.js';
import { fetchMe, SIGN_IN_URL, signOut, signOutEverywhere, type MeState } from './api.js';

/** The tab's sessionStorage, or undefined where the browser refuses it. */
function session(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Signed out: the sign-in button. Signed in: who (with the subject an admin adds them by, GWP#49), their
 * teams (each opens its work types), the form that creates a team, and the sign-out buttons (this browser,
 * or every device after a confirm, GWP#56); and the request-4-change widget when the instance has it
 * configured (GWP#10, `me.r4c`). The open team and its view come from the address (GWP#98, routing.ts);
 * sign-in returns to the address it was started from.
 */
export function Auth() {
  const [state, setState] = useState<MeState | 'loading' | 'error'>('loading');
  const route = useRoute();
  const nav = browserNavigator();

  useEffect(() => {
    fetchMe()
      .then((next) => {
        // GWP#98: sign-in lands on /; go once to the path the signed-out view was opened on, if it parses.
        if (next.status === 'signed-in') {
          const back = takeSignInRoute(session());
          if (back && nav.current().kind === 'teams') nav.navigate(back, { replace: true });
        }
        setState(next);
      })
      .catch(() => setState('error'));
  }, [nav]);

  if (state === 'loading') return <p>Checking sign-in…</p>;
  if (state === 'error') return <p role="alert">Could not check sign-in.</p>;
  if (state.status === 'signed-out') {
    return (
      <p>
        <a href={SIGN_IN_URL} role="button" data-testid="sign-in" onClick={() => rememberSignInPath(session(), window.location.pathname)}>Sign in</a>
      </p>
    );
  }

  const { me } = state;
  const teamId = route.kind === 'teams' || route.kind === 'not-found' ? undefined : route.teamId;
  const team = me.teams.find((t) => t.id === teamId);
  return (
    <section>
      <p>
        Signed in as <span data-testid="signed-in-as">{me.displayName ?? me.email}</span>{' '}
        <Identity me={me} />{' '}
        <button type="button" data-testid="sign-out" onClick={() => void signOut(me.csrfToken).finally(() => window.location.assign('/'))}>Sign out</button>{' '}
        <SignOutEverywhere csrfToken={me.csrfToken} />
      </p>
      {route.kind === 'not-found' && <NotFound />}
      {route.kind !== 'not-found' && route.kind !== 'teams' && (team
        ? (
            <TeamWorkTypes
              key={team.id}
              team={team}
              route={route}
              subject={me.subject}
              csrfToken={me.csrfToken}
              onBack={() => nav.navigate({ kind: 'teams' })}
              // GWP#20: an admin who removes themself leaves the team; reread the teams.
              onLeft={() => {
                nav.navigate({ kind: 'teams' }, { replace: true });
                fetchMe().then(setState).catch(() => setState('error'));
              }}
            />
          )
        : (
            // A team the person is not in, or no such team: the API answers 403 or 404 for it alike.
            <NotFound testId="team-not-found">You are not a member of this team, or there is no such team.</NotFound>
          ))}
      {route.kind === 'teams' && (
        <Teams
          teams={me.teams}
          csrfToken={me.csrfToken}
          onOpen={(id) => nav.navigate({ kind: 'team', teamId: id })}
          // GWP#49: reread the teams so the new one is listed with the creator as admin, then open it. The
          // team exists whatever the reread answers: if it fails, list the new team as the API made it.
          onCreated={(created) => {
            fetchMe()
              .catch((): MeState => ({ status: 'signed-in', me: { ...me, teams: [...me.teams, { id: created.id, name: created.name, role: 'admin' }] } }))
              .then((next) => {
                setState(next);
                nav.navigate({ kind: 'team', teamId: created.id });
              });
          }}
        />
      )}
      {me.r4c && <R4cWidget appId={me.r4c.appId} />}
    </section>
  );
}

/**
 * Sign out everywhere (GWP#56, POST /auth/logout/all): ends this person's sessions on every device, so it
 * asks first, as cancelling an item does. Like Sign out, it reloads to the signed-out view whatever the
 * API answers: a refused call leaves this browser's session, which the reload then shows.
 */
function SignOutEverywhere({ csrfToken }: { csrfToken: string }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" data-testid="sign-out-everywhere" onClick={() => setAsking(true)}>Sign out everywhere</button>;
  return (
    <span role="group" aria-label="Sign out everywhere">
      Sign out of every device and browser?{' '}
      <button type="button" data-testid="sign-out-everywhere-confirm" onClick={() => void signOutEverywhere(csrfToken).finally(() => window.location.assign('/'))}>Sign out everywhere</button>{' '}
      <button type="button" data-testid="sign-out-everywhere-cancel" onClick={() => setAsking(false)}>Stay signed in</button>
    </span>
  );
}

/**
 * The signed-in subject and email, as GET /api/v1/me answers them (GWP#49): an admin adds a member by
 * subject (docs/auth.md "Team membership"), so the member reads it here. Copy subject is offered only
 * where the clipboard API is; the subject stays selectable text either way.
 */
function Identity({ me }: { me: MeResponse }) {
  const [copied, setCopied] = useState<string | undefined>();
  const clipboard = navigator.clipboard as Clipboard | undefined;

  function copy() {
    if (!clipboard) return;
    clipboard.writeText(me.subject)
      .then(() => {
        setCopied('Copied');
        setTimeout(() => setCopied(undefined), 3000);
      })
      .catch(() => setCopied('Could not copy: select the subject and copy it'));
  }

  return (
    <>
      (<span data-testid="my-email">{me.email}</span>), subject <code data-testid="my-subject">{me.subject}</code>
      {clipboard && <>{' '}<button type="button" data-testid="copy-subject" onClick={copy}>Copy subject</button></>}
      {clipboard && <>{' '}<span role="status" data-testid="copy-subject-status">{copied}</span></>}
    </>
  );
}

function Teams({ teams, csrfToken, onOpen, onCreated }: { teams: MeResponse['teams']; csrfToken: string; onOpen: (teamId: string) => void; onCreated: (team: TeamResponse) => void }) {
  return (
    <>
      <h2>Your teams</h2>
      {teams.length === 0
        ? <p data-testid="no-teams">You are not in a team yet.</p>
        : (
            <ul data-testid="team-list">
              {teams.map((team) => (
                <li key={team.id}>
                  {team.name} ({team.role}){' '}
                  <button type="button" onClick={() => onOpen(team.id)} aria-label={`Open ${team.name}`}>Open</button>
                </li>
              ))}
            </ul>
          )}
      <CreateTeam csrfToken={csrfToken} onCreated={onCreated} />
    </>
  );
}

/**
 * Create a team (GWP#49, POST /api/v1/teams); the creator becomes its admin. The name is trimmed and the
 * API checks its length (1 to 120): a refused name's messages show under the input, anything else (no
 * CSRF token, a server error) as one message under the form. After a 429 (the teams-a-day quota, GWP#50)
 * the button stays disabled for the Retry-After seconds, with the count shown.
 */
function CreateTeam({ csrfToken, onCreated }: { csrfToken: string; onCreated: (team: TeamResponse) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<CaptureErrors>({});
  // A new object per 429, so a second refusal restarts the count; unmounting stops it (as ExportsPanel).
  const [hold, setHold] = useState<{ seconds: number } | undefined>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => hold && startExportWait(hold.seconds, (left) => {
    setSecondsLeft(left);
    if (left === 0) setHold(undefined);
  }), [hold]);
  const { name: nameErrors, ...rest } = errors;
  const formErrors = Object.values(rest).flat();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    const result = await createTeam(name.trim(), csrfToken).catch((): WriteResult<TeamResponse> => ({ ok: false, errors: { [FORM_ERROR_KEY]: ['Could not reach the server'] } }));
    setBusy(false);
    if (result.ok) {
      setName('');
      onCreated(result.value);
    } else {
      setErrors(result.errors);
      if (result.retryAfterSeconds !== undefined) setHold({ seconds: result.retryAfterSeconds });
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-labelledby="create-team-title" data-testid="create-team">
      <h3 id="create-team-title">Create a team</h3>
      <p>
        <label htmlFor="create-team-name">Team name</label>{' '}
        <input
          id="create-team-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          aria-invalid={nameErrors ? true : undefined}
          aria-describedby={nameErrors ? 'create-team-name-error' : undefined}
        />{' '}
        <button type="submit" disabled={busy || hold !== undefined || name.trim() === ''} data-testid="create-team-submit">Create team</button>
      </p>
      {nameErrors && (
        <div role="alert">
          <ul id="create-team-name-error" data-testid="create-team-name-error">
            {nameErrors.map((message, index) => <li key={index}>{message}</li>)}
          </ul>
        </div>
      )}
      {formErrors.length > 0 && <p role="alert" data-testid="create-team-error">{formErrors.join(' ')}</p>}
      {secondsLeft > 0 && <p data-testid="create-team-wait">{waitMessage(secondsLeft, 'create a team')}</p>}
    </form>
  );
}
