// Provision the OnCall objects (oncall/definitions.ts) and return the integration's link, which the
// alerting contact point points at. Order: the Grafana team and its owner, the OnCall team IRM synced
// from it, the escalation chain and its one step, the integration, and its severity route.

import type { GrafanaClient, Json } from '../lib/grafana-client.js';
import { ApplyError, Mismatch, reconcile, type Report } from '../lib/reconcile.js';
import { ESCALATION_STEP, oncallDefinitions } from './definitions.js';

export interface OncallContext {
  grafana: GrafanaClient;
  oncall: GrafanaClient;
  /** The owner's Grafana login (GRAFANA_ONCALL_OWNER), the team's first member. */
  ownerLogin: string;
  report: Report;
}

export function planOncall(): string[] {
  const defs = oncallDefinitions();
  const step = ESCALATION_STEP;
  return [
    `grafana-team ${defs.team.name}: first member the login in GRAFANA_ONCALL_OWNER`,
    `oncall-team ${defs.team.name}: synced by IRM from the Grafana team`,
    `oncall-escalation-chain ${defs.escalationChain.name}: one step, ${step.type} ${step.team}${step.important ? ' (important)' : ''}`,
    `oncall-integration ${defs.integration.name} (${defs.integration.type}): default route pages nobody`,
    ...defs.routes.map((r) => `oncall-route ${r.routing_regex} -> ${r.escalationChain}`),
  ];
}

async function ensureGrafanaTeam(ctx: OncallContext, name: string): Promise<void> {
  const find = async () => (await ctx.grafana.get<{ teams: Json[] }>(`/api/teams/search?name=${encodeURIComponent(name)}`))?.teams.find((t) => t.name === name);
  const team = await reconcile(
    { kind: 'grafana-team', name, desired: { name }, read: find, create: () => ctx.grafana.post('/api/teams', { name }), update: async () => undefined },
    ctx.report,
  );
  const teamId = team.actual.id as number;
  const users = (await ctx.grafana.get<Json[]>(`/api/org/users/lookup?query=${encodeURIComponent(ctx.ownerLogin)}&limit=100`)) ?? [];
  const owner = users.find((u) => u.login === ctx.ownerLogin);
  if (!owner) throw new ApplyError(`GRAFANA_ONCALL_OWNER: no user with that login in the stack's organisation`);
  // The owner must be a member; members added by hand stay (Out of scope: further members, by the owner).
  const members = async () => (await ctx.grafana.get<Json[]>(`/api/teams/${teamId}/members`)) ?? [];
  await reconcile(
    {
      kind: 'grafana-team-member',
      name: `${name} owner`,
      desired: true,
      read: async () => (await members()).some((m) => m.userId === owner.userId) || undefined,
      create: () => ctx.grafana.post(`/api/teams/${teamId}/members`, { userId: owner.userId }),
      update: async () => undefined,
    },
    ctx.report,
  );
}

export async function applyOncall(ctx: OncallContext): Promise<{ integrationLink: string }> {
  const defs = oncallDefinitions();
  await ensureGrafanaTeam(ctx, defs.team.name);

  const oncallTeam = (await ctx.oncall.list(`/api/v1/teams/?name=${encodeURIComponent(defs.team.name)}`)).find((t) => t.name === defs.team.name);
  if (!oncallTeam) {
    throw new ApplyError(
      `OnCall has no team ${defs.team.name} yet: IRM syncs Grafana teams when an IRM page loads, else every 4 hours. Open IRM in the stack once to sync, then re-run.`,
    );
  }
  const teamId = oncallTeam.id as string;

  const chainDesired = { name: defs.escalationChain.name, team_id: teamId };
  const chain = await reconcile(
    {
      kind: 'oncall-escalation-chain',
      name: chainDesired.name,
      desired: chainDesired,
      read: async () => (await ctx.oncall.list('/api/v1/escalation_chains/')).find((c) => c.name === chainDesired.name),
      create: () => ctx.oncall.post('/api/v1/escalation_chains/', chainDesired),
      // The API has no update for a chain; one owned by another team is fixed by hand.
      update: async () => {
        throw new Mismatch(`oncall-escalation-chain ${chainDesired.name}: exists with another team; delete it in IRM and re-run`);
      },
    },
    ctx.report,
  );
  const chainId = chain.actual.id as string;

  // Exactly one step: notify the team. Extra steps are removed so the team stays the only target.
  const step = ESCALATION_STEP;
  const stepDesired = { escalation_chain_id: chainId, position: 0, type: step.type, team_to_notify: teamId, important: step.important };
  const steps = async () => ctx.oncall.list(`/api/v1/escalation_policies/?escalation_chain_id=${encodeURIComponent(chainId)}`);
  await reconcile(
    {
      kind: 'oncall-escalation-policy',
      name: `${chainDesired.name} step 1`,
      desired: [stepDesired],
      read: async () => {
        const found = await steps();
        return found.length === 0 ? undefined : found;
      },
      create: () => ctx.oncall.post('/api/v1/escalation_policies/', stepDesired),
      update: async (found) => {
        const [first, ...rest] = found;
        for (const extra of rest) await ctx.oncall.delete(`/api/v1/escalation_policies/${String(extra.id)}/`);
        await ctx.oncall.put(`/api/v1/escalation_policies/${String(first?.id)}/`, stepDesired);
      },
    },
    ctx.report,
  );

  const integrationDesired = { name: defs.integration.name, type: defs.integration.type, team_id: teamId, default_route: { escalation_chain_id: defs.integration.defaultEscalationChain } };
  const integration = await reconcile(
    {
      kind: 'oncall-integration',
      name: integrationDesired.name,
      desired: integrationDesired,
      read: async () => (await ctx.oncall.list('/api/v1/integrations/')).find((i) => i.name === integrationDesired.name),
      create: () => ctx.oncall.post('/api/v1/integrations/', integrationDesired),
      update: (found) => ctx.oncall.put(`/api/v1/integrations/${String(found.id)}/`, { name: integrationDesired.name, team_id: teamId, default_route: integrationDesired.default_route }),
    },
    ctx.report,
  );
  const integrationId = integration.actual.id as string;

  for (const route of defs.routes) {
    const desired = { integration_id: integrationId, routing_type: route.routing_type, routing_regex: route.routing_regex, escalation_chain_id: chainId };
    await reconcile(
      {
        kind: 'oncall-route',
        name: `${integrationDesired.name} ${route.routing_regex}`,
        desired,
        read: async () => (await ctx.oncall.list(`/api/v1/routes/?integration_id=${encodeURIComponent(integrationId)}`)).find((r) => r.routing_regex === route.routing_regex),
        create: () => ctx.oncall.post('/api/v1/routes/', { ...desired, position: 0 }),
        update: (found) => ctx.oncall.put(`/api/v1/routes/${String(found.id)}/`, desired),
      },
      ctx.report,
    );
  }

  const link = integration.actual.link;
  if (typeof link !== 'string' || link === '') throw new ApplyError(`oncall-integration ${integrationDesired.name} has no link to send alerts to`);
  return { integrationLink: link };
}
