// An in-memory Grafana Cloud stack for apply.test.ts. Response shapes follow the documented APIs
// (recorded from the Grafana HTTP API, alerting provisioning, SLO plugin and OnCall v1 references; see
// docs/observability.md): Grafana teams and org users, the OnCall teams, escalation chains, escalation
// policies, integrations and routes (paginated `results`), contact points, the policy tree, folders,
// SLOs, alert rules and dashboards. It stores what it is sent, so a read after a write returns it,
// unless a test registers a `tamper` that changes what the stack keeps.

export const STACK_URL = 'https://stack.example.test';
export const ONCALL_URL = 'https://oncall.example.test';
export const OWNER_LOGIN = 'owner-login';

export interface Call {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

type Json = Record<string, unknown>;

export interface FakeGrafana {
  fetch: typeof fetch;
  calls: Call[];
  writes(): Call[];
  /** Change what the stack keeps for a write, as a server that drops or rewrites a field would. */
  tamper(fn: (path: string, body: Json) => Json): void;
  /** Make OnCall miss the synced team, as before IRM's first team sync. */
  oncallTeamSynced: boolean;
  /** Make OnCall's team list ignore the name filter and put another team first. */
  oncallTeamsIgnoreName: boolean;
  /** Make the integration list say there is a next page, at this origin. */
  paginateTo: string | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function page(results: unknown[]): Json {
  return { count: results.length, next: null, previous: null, results, current_page_number: 1, page_size: 50, total_pages: 1 };
}

export function createFakeGrafana(): FakeGrafana {
  const calls: Call[] = [];
  let tamper: (path: string, body: Json) => Json = (_path, body) => body;
  let nextId = 1;
  const id = (prefix: string) => `${prefix}${nextId++}`;

  const users = [{ userId: 7, login: OWNER_LOGIN, email: 'owner@example.test' }, { userId: 8, login: 'someone-else', email: 'other@example.test' }];
  const grafanaTeams: Json[] = [];
  const teamMembers = new Map<number, number[]>();
  const oncallTeams: Json[] = [];
  const chains: Json[] = [];
  const policies: Json[] = [];
  const integrations: Json[] = [];
  const routes: Json[] = [];
  const contactPoints: Json[] = [];
  let policyTree: Json = { receiver: 'grafana-default-email', group_by: ['grafana_folder', 'alertname'] };
  const folders = new Map<string, Json>();
  const slos: Json[] = [];
  const rules = new Map<string, Json>();
  const dashboards = new Map<string, Json>();

  const fake: FakeGrafana = {
    calls,
    oncallTeamSynced: true,
    oncallTeamsIgnoreName: false,
    paginateTo: undefined,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    tamper: (fn) => {
      tamper = fn;
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ method, url: url.toString(), body, headers });
      // The stack takes a bearer token; OnCall only a bare service-account token, matched on its
      // glsa_ prefix (grafana/oncall engine/apps/auth_token/auth.py), and answers anything else 401.
      const expected = url.origin === ONCALL_URL ? 'glsa_test' : 'Bearer glsa_test';
      if (headers.authorization !== expected) return json(401, { message: 'unauthorized' });
      const keep = (b: Json) => tamper(url.pathname, structuredClone(b));
      const path = url.pathname;
      const q = url.searchParams;

      if (url.origin === ONCALL_URL) {
        if (headers['x-grafana-url'] !== STACK_URL) return json(401, { detail: 'missing X-Grafana-URL' });
        let m: RegExpMatchArray | null;
        if (path === '/api/v1/integrations/' && method === 'GET' && fake.paginateTo) return json(200, { ...page(integrations), next: `${fake.paginateTo}/api/v1/integrations/?page=2` });
        if (path === '/api/v1/teams/' && method === 'GET') {
          if (fake.oncallTeamSynced && oncallTeams.length === 0) {
            for (const t of grafanaTeams) oncallTeams.push({ id: `T${String(t.id)}`, grafana_id: t.id, name: t.name, email: '', avatar_url: '' });
          }
          if (!fake.oncallTeamSynced) return json(200, page([]));
          if (fake.oncallTeamsIgnoreName) return json(200, page([{ id: 'TX', name: 'someone-elses-team' }, ...oncallTeams]));
          return json(200, page(oncallTeams.filter((t) => t.name === q.get('name'))));
        }
        if (path === '/api/v1/escalation_chains/') {
          if (method === 'GET') return json(200, page(chains));
          const chain = { id: id('F'), team_id: null, ...keep(body!) };
          chains.push(chain);
          return json(201, chain);
        }
        if (path === '/api/v1/escalation_policies/') {
          if (method === 'GET') return json(200, page(policies.filter((p) => p.escalation_chain_id === q.get('escalation_chain_id'))));
          const policy = { id: id('E'), important: false, ...keep(body!) };
          policies.push(policy);
          return json(201, policy);
        }
        if ((m = /^\/api\/v1\/escalation_policies\/(\w+)\/$/.exec(path))) {
          const index = policies.findIndex((p) => p.id === m![1]);
          if (method === 'DELETE') {
            policies.splice(index, 1);
            return json(204, undefined);
          }
          policies[index] = { ...policies[index], ...keep(body!) };
          return json(200, policies[index]);
        }
        if (path === '/api/v1/integrations/') {
          if (method === 'GET') return json(200, page(integrations));
          const integrationId = id('C');
          const integration = { id: integrationId, link: `${ONCALL_URL}/integrations/v1/grafana_alerting/${integrationId}/`, team_id: null, ...keep(body!) };
          integrations.push(integration);
          return json(201, integration);
        }
        if ((m = /^\/api\/v1\/integrations\/(\w+)\/$/.exec(path))) {
          const index = integrations.findIndex((i) => i.id === m![1]);
          integrations[index] = { ...integrations[index], ...keep(body!) };
          return json(200, integrations[index]);
        }
        if (path === '/api/v1/routes/') {
          if (method === 'GET') return json(200, page(routes.filter((r) => r.integration_id === q.get('integration_id'))));
          const route = { id: id('R'), is_the_last_route: false, ...keep(body!) };
          routes.push(route);
          return json(201, route);
        }
        if ((m = /^\/api\/v1\/routes\/(\w+)\/$/.exec(path))) {
          const index = routes.findIndex((r) => r.id === m![1]);
          routes[index] = { ...routes[index], ...keep(body!) };
          return json(200, routes[index]);
        }
        return json(404, { detail: 'not found' });
      }

      if (url.origin !== STACK_URL) return json(404, { message: 'unknown host' });
      let m: RegExpMatchArray | null;
      if (path === '/api/teams/search' && method === 'GET') {
        const teams = grafanaTeams.filter((t) => t.name === q.get('name'));
        return json(200, { totalCount: teams.length, teams, page: 1, perPage: 1000 });
      }
      if (path === '/api/teams' && method === 'POST') {
        const teamId = nextId++;
        grafanaTeams.push({ id: teamId, uid: `team-${teamId}`, ...keep(body!) });
        teamMembers.set(teamId, []);
        return json(200, { message: 'Team created', teamId });
      }
      if ((m = /^\/api\/teams\/(\d+)\/members$/.exec(path))) {
        const members = teamMembers.get(Number(m[1])) ?? [];
        if (method === 'GET') return json(200, members.map((userId) => ({ userId, teamId: Number(m![1]), login: users.find((u) => u.userId === userId)!.login })));
        const kept = keep(body!);
        members.push(kept.userId as number);
        return json(200, { message: 'Member added to Team' });
      }
      if (path === '/api/org/users/lookup' && method === 'GET') {
        const query = q.get('query') ?? '';
        return json(200, users.filter((u) => u.login.includes(query) || u.email.includes(query)).map((u) => ({ userId: u.userId, login: u.email === query ? u.login : u.login, avatarUrl: '' })));
      }
      if (path === '/api/v1/provisioning/contact-points') {
        if (method === 'GET') return json(200, contactPoints.filter((c) => c.name === q.get('name')));
        const point = keep(body!);
        contactPoints.push(point);
        return json(202, point);
      }
      if ((m = /^\/api\/v1\/provisioning\/contact-points\/([\w-]+)$/.exec(path))) {
        const index = contactPoints.findIndex((c) => c.uid === m![1]);
        contactPoints[index] = keep(body!);
        return json(202, { message: 'contactpoint updated' });
      }
      if (path === '/api/v1/provisioning/policies') {
        if (method === 'GET') return json(200, policyTree);
        // Grafana serialises the tree with omitempty: a false `continue` is not read back.
        policyTree = JSON.parse(JSON.stringify(keep(body!), (key, value: unknown) => (key === 'continue' && value === false ? undefined : value))) as Json;
        return json(202, { message: 'policies updated' });
      }
      if (path === '/api/folders' && method === 'POST') {
        const folder: Json = { id: nextId++, version: 1, ...keep(body!) };
        folders.set(folder.uid as string, folder);
        return json(200, folder);
      }
      if ((m = /^\/api\/folders\/([\w-]+)$/.exec(path))) {
        const folder = folders.get(m[1]!);
        if (method === 'GET') return folder ? json(200, folder) : json(404, { message: 'folder not found' });
        const updated = { ...folder, ...keep(body!), version: Number(folder?.version ?? 0) + 1 };
        folders.set(m[1]!, updated);
        return json(200, updated);
      }
      if (path === '/api/plugins/grafana-slo-app/resources/v1/slo') {
        if (method === 'GET') return json(200, { slos });
        const uuid = id('slo');
        slos.push({ uuid, readOnly: { status: { type: 'creating' } }, ...keep(body!) });
        return json(202, { uuid, message: 'SLO created' });
      }
      if ((m = /^\/api\/plugins\/grafana-slo-app\/resources\/v1\/slo\/(\w+)$/.exec(path))) {
        const index = slos.findIndex((s) => s.uuid === m![1]);
        if (method === 'GET') return index === -1 ? json(404, { code: 404, error: 'not found' }) : json(200, slos[index]);
        slos[index] = { uuid: m[1], readOnly: slos[index]!.readOnly, ...keep(body!) };
        return json(200, { message: 'SLO updated' });
      }
      if (path === '/api/v1/provisioning/alert-rules' && method === 'POST') {
        const rule: Json = { id: nextId++, orgID: 1, updated: '2026-10-22T00:00:00Z', provenance: 'api', ...keep(body!) };
        rules.set(rule.uid as string, rule);
        return json(201, rule);
      }
      if ((m = /^\/api\/v1\/provisioning\/alert-rules\/([\w-]+)$/.exec(path))) {
        const rule = rules.get(m[1]!);
        if (method === 'GET') return rule ? json(200, rule) : json(404, { message: 'rule not found' });
        rules.set(m[1]!, { ...rule, ...keep(body!) });
        return json(200, rules.get(m[1]!));
      }
      if (path === '/api/dashboards/db' && method === 'POST') {
        const kept = keep(body!);
        const dashboard: Json = { ...(kept.dashboard as Json), id: nextId++, version: 1 };
        dashboards.set(dashboard.uid as string, { dashboard, meta: { folderUid: kept.folderUid } });
        return json(200, { status: 'success', uid: dashboard.uid, version: 1 });
      }
      if ((m = /^\/api\/dashboards\/uid\/([\w-]+)$/.exec(path))) {
        const found = dashboards.get(m[1]!);
        return found ? json(200, found) : json(404, { message: 'Dashboard not found' });
      }
      return json(404, { message: `no route ${method} ${path}` });
    },
  };
  return fake;
}
