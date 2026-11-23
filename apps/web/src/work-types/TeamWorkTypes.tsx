import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FORM_ERROR_KEY, type TeamRole, type WorkTypeResponse } from '@getworkdone/contracts';
import { ItemView } from '../items/item-view.js';
import { NotFound } from '../not-found.js';
import { browserNavigator, type KnownRoute } from '../routing.js';
import { Members } from '../teams/Members.js';
import { archiveWorkType, listWorkTypes } from './api.js';
import { Builder } from './builder/Builder.js';
import { CapturePage } from './capture/CapturePage.js';
import { WaitingForYou } from './WaitingForYou.js';

/** The routes of one team's pages (GWP#98, routing.ts). */
export type TeamRoute = Exclude<KnownRoute, { kind: 'teams' }>;

/**
 * A team's work types: the items waiting for you (GWP#55), capture an item of one (members), or build or
 * change one, archive or unarchive it (GWP#55) and manage the team's members (admins). Archived work types
 * sit in a collapsed section, where their items stay readable. Which page shows comes from the address
 * (GWP#98): the route names the work type or item by id, resolved here against the team's work types.
 */
export function TeamWorkTypes({ team, route, subject, csrfToken, onBack, onLeft }: { team: { id: string; name: string; role: TeamRole }; route: TeamRoute; subject: string; csrfToken: string; onBack: () => void; onLeft: () => void }) {
  const [workTypes, setWorkTypes] = useState<WorkTypeResponse[] | 'error' | undefined>();
  const nav = browserNavigator();
  const list: KnownRoute = { kind: 'team', teamId: team.id };
  // GWP#6: the webhook signing secrets the last save generated, shown once (no read returns them).
  const [secrets, setSecrets] = useState<{ slug: string; secrets: Record<string, string> } | undefined>();
  const [archiveError, setArchiveError] = useState<string | undefined>();
  const admin = team.role === 'admin';

  const refresh = useCallback(() => {
    listWorkTypes(team.id).then(setWorkTypes).catch(() => setWorkTypes('error'));
  }, [team.id]);
  useEffect(refresh, [refresh]);

  async function setArchived(workType: WorkTypeResponse, archived: boolean) {
    setArchiveError(undefined);
    const result = await archiveWorkType(team.id, workType.id, archived, csrfToken);
    if (!result.ok) setArchiveError(result.errors[FORM_ERROR_KEY]?.join(' ') ?? `Could not ${archived ? 'archive' : 'unarchive'} ${workType.slug}`);
    refresh();
  }

  const go = (to: KnownRoute) => nav.navigate(to);
  const openItem = (itemId: string) => nav.navigate({ kind: 'item', teamId: team.id, itemId }, { from: route });

  /** The work type an edit or capture route names, once the list has loaded; a message while it has not. */
  function withWorkType(workTypeId: string, render: (workType: WorkTypeResponse) => ReactNode) {
    if (workTypes === undefined) return <p>Loading work types…</p>;
    if (workTypes === 'error') return <p role="alert">Could not load the work types.</p>;
    const workType = workTypes.find((wt) => wt.id === workTypeId);
    return workType
      ? render(workType)
      : <NotFound testId="work-type-not-found" to={list} linkText={`Go to ${team.name}`}>This team has no such work type.</NotFound>;
  }

  function builder(workType: WorkTypeResponse | undefined) {
    return (
      <Builder
        key={workType?.id ?? 'new'}
        teamId={team.id}
        csrfToken={csrfToken}
        {...(workType ? { workType } : {})}
        onSaved={(saved) => {
          refresh();
          setSecrets(saved.webhookSecrets ? { slug: saved.slug, secrets: saved.webhookSecrets } : undefined);
          // Replaced, so Back from the list does not reopen the saved builder.
          nav.navigate(list, { replace: true });
        }}
        onCancel={() => go(list)}
      />
    );
  }

  const active = Array.isArray(workTypes) ? workTypes.filter((wt) => wt.archivedAt === null) : [];
  const archived = Array.isArray(workTypes) ? workTypes.filter((wt) => wt.archivedAt !== null) : [];

  return (
    <section aria-labelledby="team-title">
      <h2 id="team-title">{team.name}</h2>
      <p data-testid="team-role">Your role: {team.role}</p>
      <p><button type="button" onClick={route.kind === 'team' ? onBack : () => go(list)} data-testid="back">Back</button></p>
      {route.kind === 'new-work-type' && builder(undefined)}
      {route.kind === 'edit-work-type' && withWorkType(route.workTypeId, builder)}
      {route.kind === 'members' && <Members teamId={team.id} subject={subject} csrfToken={csrfToken} onLeft={onLeft} />}
      {route.kind === 'capture' && withWorkType(route.workTypeId, (workType) => (
        <CapturePage key={workType.id} teamId={team.id} workType={workType} csrfToken={csrfToken} onReloaded={refresh} onOpenItem={openItem} />
      ))}
      {route.kind === 'item' && (
        // Back returns to the list the item was opened from, or to the team's page for a pasted link. Only openItem
        // records a from, and ItemView navigates nowhere else, so with a from the entry before this one is that list.
        <ItemView teamId={team.id} itemId={route.itemId} role={team.role} csrfToken={csrfToken} onBack={() => (nav.from() ? nav.back() : go(list))} />
      )}
      {route.kind === 'team' && (
        <>
          <WaitingForYou teamId={team.id} onOpen={openItem} />
          {secrets && (
            <section role="status" aria-labelledby="webhook-secrets-title" data-testid="webhook-secrets">
              <h3 id="webhook-secrets-title">Webhook signing secrets for {secrets.slug}</h3>
              <p>Copy each secret to its receiver now: it is not shown again. The receiver checks X-GetWorkDone-Signature, the HMAC-SHA256 of the request body under this secret.</p>
              <dl>
                {Object.entries(secrets.secrets).map(([outputId, secret]) => (
                  <div key={outputId}><dt>{outputId}</dt><dd><code data-testid={`webhook-secret-${outputId}`}>{secret}</code></dd></div>
                ))}
              </dl>
              <button type="button" onClick={() => setSecrets(undefined)}>I have copied them</button>
            </section>
          )}
          <h3>Work types</h3>
          {workTypes === undefined && <p>Loading work types…</p>}
          {workTypes === 'error' && <p role="alert">Could not load the work types.</p>}
          {archiveError && <p role="alert" data-testid="work-type-archive-error">{archiveError}</p>}
          {Array.isArray(workTypes) && (active.length === 0
            ? <p data-testid="no-work-types">{archived.length > 0 ? 'No work types in use.' : 'No work types yet.'}</p>
            : (
                <ul data-testid="work-type-list">
                  {active.map((wt) => (
                    <li key={wt.id}>
                      {wt.slug} (version {wt.version.version}){' '}
                      <button type="button" onClick={() => go({ kind: 'capture', teamId: team.id, workTypeId: wt.id })} aria-label={`Capture ${wt.slug}`}>Capture</button>{' '}
                      {admin && <button type="button" onClick={() => go({ kind: 'edit-work-type', teamId: team.id, workTypeId: wt.id })} aria-label={`Edit fields of ${wt.slug}`}>Edit fields</button>}{' '}
                      {admin && <button type="button" onClick={() => void setArchived(wt, true)} aria-label={`Archive ${wt.slug}`}>Archive</button>}
                    </li>
                  ))}
                </ul>
              ))}
          {archived.length > 0 && (
            <details data-testid="archived-work-types">
              <summary>Archived work types ({archived.length})</summary>
              <p>An archived work type takes no new items or versions; its items and exports stay readable.</p>
              <ul data-testid="archived-work-type-list">
                {archived.map((wt) => (
                  <li key={wt.id}>
                    {wt.slug} (version {wt.version.version}){' '}
                    <button type="button" onClick={() => go({ kind: 'capture', teamId: team.id, workTypeId: wt.id })} aria-label={`Items of ${wt.slug}`}>Items</button>{' '}
                    {admin && <button type="button" onClick={() => void setArchived(wt, false)} aria-label={`Unarchive ${wt.slug}`}>Unarchive</button>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {admin && (
            <p>
              <button type="button" data-testid="new-work-type" onClick={() => go({ kind: 'new-work-type', teamId: team.id })}>New work type</button>{' '}
              <button type="button" data-testid="team-members" onClick={() => go({ kind: 'members', teamId: team.id })}>Members</button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
