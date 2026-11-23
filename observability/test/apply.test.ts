import { describe, expect, it } from 'vitest';
import { main } from '../apply.js';
import { notificationPolicy, type Route } from '../alerting/definitions.js';
import { signalRules } from '../signals/definitions.js';
import { burnRateRules } from '../slo/definitions.js';
import { createFakeGrafana, ONCALL_URL, OWNER_LOGIN, STACK_URL } from './fake-grafana.js';

const LIVE_ENV = { GRAFANA_URL: STACK_URL, GRAFANA_TOKEN: 'glsa_test', GRAFANA_ONCALL_URL: ONCALL_URL, GRAFANA_ONCALL_OWNER: OWNER_LOGIN };

async function integrationId(fake: ReturnType<typeof createFakeGrafana>): Promise<string> {
  const created = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/integrations/'))!;
  const list = (await (await fake.fetch(`${ONCALL_URL}/api/v1/integrations/`, { headers: { authorization: 'glsa_test', 'x-grafana-url': STACK_URL } })).json()) as { results: { id: string; name: string }[] };
  return list.results.find((i) => i.name === (created.body as { name: string }).name)!.id.slice(1);
}

async function run(args: string[], env: Record<string, string | undefined>, fetchImpl: typeof fetch) {
  let stdout = '';
  let stderr = '';
  const status = await main(args, { env, fetch: fetchImpl, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

describe('apply.ts --dry-run', () => {
  it('prints the plan with no network: 3 SLOs and 6 burn-rate rules, 2 of them on the latency SLO', async () => {
    const fake = createFakeGrafana();
    const result = await run(['--dry-run'], {}, fake.fetch);
    expect(result.status).toBe(0);
    expect(fake.calls).toEqual([]);
    const lines = result.stdout.split('\n');
    expect(lines.filter((l) => l.startsWith('  slo '))).toHaveLength(3);
    const burn = lines.filter((l) => l.startsWith('  burn-rate-rule '));
    expect(burn).toHaveLength(6);
    expect(burn.filter((l) => l.includes('slo=getworkdone-api-latency'))).toHaveLength(2);
    expect(result.stdout).toContain('environment getworkdone');
    expect(result.stdout).toContain('3 SLOs, 6 burn-rate rules');
  });

  it('plans 11 alert rules per environment in two groups: 6 burn-rate rules and 5 signal rules (GWP#53)', async () => {
    for (const environment of ['getworkdone', 'getworkdone-dev']) {
      const result = await run(['--dry-run', '--environment', environment], {}, createFakeGrafana().fetch);
      expect(result.status).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines.filter((l) => l.startsWith('  burn-rate-rule '))).toHaveLength(6);
      const signals = lines.filter((l) => l.startsWith('  signal-rule '));
      expect(signals).toHaveLength(5);
      expect(signals.every((l) => l.includes(`group ${environment}-signals`))).toBe(true);
      expect(result.stdout).toContain(`11 alert rules in 2 groups (${environment}-slo-burn, ${environment}-signals)`);
    }
  });

  it('plans getworkdone-dev with --environment and refuses an unknown environment with exit 2', async () => {
    const fake = createFakeGrafana();
    const dev = await run(['--dry-run', '--environment', 'getworkdone-dev'], {}, fake.fetch);
    expect(dev.status).toBe(0);
    expect(dev.stdout).toContain('slo=getworkdone-dev-api-latency');
    const bad = await run(['--dry-run', '--environment', 'prod'], {}, fake.fetch);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('getworkdone, getworkdone-dev');
    expect(fake.calls).toEqual([]);
  });
});

describe('apply.ts live', () => {
  it('missing GRAFANA_URL or GRAFANA_TOKEN in live mode exits 2 before any request', async () => {
    for (const missing of ['GRAFANA_URL', 'GRAFANA_TOKEN', 'GRAFANA_ONCALL_URL', 'GRAFANA_ONCALL_OWNER']) {
      const fake = createFakeGrafana();
      const result = await run([], { ...LIVE_ENV, [missing]: undefined }, fake.fetch);
      expect(result.status, missing).toBe(2);
      expect(result.stderr).toContain(missing);
      expect(fake.calls).toEqual([]);
    }
  });

  it('creates every object, reads each back, and points the contact point at the integration it created', async () => {
    const fake = createFakeGrafana();
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified');
    const posted = (suffix: string) => fake.writes().filter((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith(suffix));
    expect(posted('/v1/slo')).toHaveLength(3);
    expect(posted('/provisioning/alert-rules')).toHaveLength(11);
    const groups = posted('/provisioning/alert-rules').map((c) => (c.body as { ruleGroup: string }).ruleGroup);
    expect(groups.filter((g) => g === 'getworkdone-signals')).toHaveLength(5);
    const integrationLink = `${ONCALL_URL}/integrations/v1/grafana_alerting/C`;
    const point = posted('/provisioning/contact-points')[0]!.body as { type: string; settings: { url: string } };
    expect(point.type).toBe('oncall');
    expect(point.settings.url.startsWith(integrationLink)).toBe(true);
    expect(posted('/members')[0]!.body).toEqual({ userId: 7 });
    // OnCall calls carry the bare token and the stack URL; stack calls carry it as a bearer token.
    const oncallCalls = fake.calls.filter((c) => c.url.startsWith(ONCALL_URL));
    expect(oncallCalls.length).toBeGreaterThan(0);
    expect(oncallCalls.every((c) => c.headers['x-grafana-url'] === STACK_URL && c.headers.authorization === 'glsa_test')).toBe(true);
    expect(fake.calls.filter((c) => c.url.startsWith(STACK_URL)).every((c) => c.headers.authorization === 'Bearer glsa_test')).toBe(true);
    // GET after write: every write is followed by a read of the same object.
    expect(fake.calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(fake.writes().length);
  });

  it('a second run is a no-op', async () => {
    const fake = createFakeGrafana();
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    const before = fake.writes().length;
    const second = await run([], LIVE_ENV, fake.fetch);
    expect(second.status).toBe(0);
    expect(fake.writes().slice(before)).toEqual([]);
    expect(second.stdout).toContain('unchanged');
  });

  it('puts back objects changed by hand, removes extra escalation steps, then is a no-op again', async () => {
    const fake = createFakeGrafana();
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    const send = (method: string, url: string, body: unknown) =>
      fake.fetch(url, { method, headers: { authorization: url.startsWith(ONCALL_URL) ? 'glsa_test' : 'Bearer glsa_test', 'x-grafana-url': STACK_URL }, body: JSON.stringify(body) });
    await send('PUT', `${STACK_URL}/api/v1/provisioning/policies`, { receiver: 'grafana-default-email' });
    await send('PUT', `${STACK_URL}/api/v1/provisioning/contact-points/getworkdone-oncall`, { uid: 'getworkdone-oncall', name: 'getworkdone-oncall', type: 'webhook', settings: { url: 'https://placeholder.invalid' } });
    await send('PUT', `${STACK_URL}/api/v1/provisioning/alert-rules/gwd-api-latency-fast`, { labels: { slo: 'getworkdone-api-latency' } });
    await send('PUT', `${STACK_URL}/api/v1/provisioning/alert-rules/gwd-telemetry-heartbeat`, { noDataState: 'NoData' });
    const slos = (await (await fake.fetch(`${STACK_URL}/api/plugins/grafana-slo-app/resources/v1/slo`, { headers: { authorization: 'Bearer glsa_test' } })).json()) as { slos: { uuid: string; name: string }[] };
    const latency = slos.slos.find((s) => s.name === 'getworkdone-api-latency')!;
    await send('PUT', `${STACK_URL}/api/plugins/grafana-slo-app/resources/v1/slo/${latency.uuid}`, { name: latency.name, objectives: [{ value: 0.5, window: '28d' }] });
    const chain = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/escalation_chains/'))!;
    const chainId = (await (await fake.fetch(`${ONCALL_URL}/api/v1/escalation_chains/`, { headers: { authorization: 'glsa_test', 'x-grafana-url': STACK_URL } })).json() as { results: { id: string; name: string }[] }).results.find((c) => c.name === (chain.body as { name: string }).name)!.id;
    await send('POST', `${ONCALL_URL}/api/v1/escalation_policies/`, { escalation_chain_id: chainId, position: 1, type: 'notify_team_members', team_to_notify: 'T0' });
    await send('PUT', `${ONCALL_URL}/api/v1/integrations/C${(await integrationId(fake))}/`, { default_route: { escalation_chain_id: chainId } });

    const before = fake.writes().length;
    const repair = await run([], LIVE_ENV, fake.fetch);
    expect(repair.stderr).toBe('');
    expect(repair.status).toBe(0);
    for (const kind of ['notification-policy root', 'contact-point getworkdone-oncall', 'burn-rate-rule gwd-api-latency-fast', 'signal-rule gwd-telemetry-heartbeat', 'slo getworkdone-api-latency', 'oncall-escalation-policy', 'oncall-integration']) {
      expect(repair.stdout).toContain(`updated ${kind}`);
    }
    expect(fake.writes().slice(before).some((c) => c.method === 'DELETE')).toBe(true);
    const settled = fake.writes().length;
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    expect(fake.writes().slice(settled)).toEqual([]);
  });

  it('a read-back mismatch exits 1 and names the object', async () => {
    const fake = createFakeGrafana();
    fake.tamper((path, body) => (path.startsWith('/api/v1/provisioning/contact-points') ? { ...body, settings: { url: 'https://placeholder.invalid' } } : body));
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('contact-point getworkdone-oncall');
    expect(result.stderr).toContain('settings.url');
  });

  it('exits 1 when OnCall has not synced the Grafana team yet, naming the fix', async () => {
    const fake = createFakeGrafana();
    fake.oncallTeamSynced = false;
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prebutton-maintainers');
    expect(result.stderr).toContain('sync');
  });

  it('exits 1 when the owner login is not a user of the stack', async () => {
    const fake = createFakeGrafana();
    const result = await run([], { ...LIVE_ENV, GRAFANA_ONCALL_OWNER: 'nobody' }, fake.fetch);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GRAFANA_ONCALL_OWNER');
  });

  it('keeps a member the owner added by hand and still verifies', async () => {
    const fake = createFakeGrafana();
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    await fake.fetch(`${STACK_URL}/api/teams/1/members`, { method: 'POST', headers: { authorization: 'Bearer glsa_test' }, body: JSON.stringify({ userId: 8 }) });
    const before = fake.writes().length;
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    expect(fake.writes().slice(before)).toEqual([]);
  });

  it('reads the OnCall team by its exact name, not whichever team the list puts first', async () => {
    const fake = createFakeGrafana();
    fake.oncallTeamsIgnoreName = true;
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    const chain = fake.writes().find((c) => c.url.endsWith('/escalation_chains/'))!;
    expect((chain.body as { team_id: string }).team_id).not.toBe('TX');
  });

  it('exits 1 rather than act on a list whose next page is on another host', async () => {
    const fake = createFakeGrafana();
    fake.paginateTo = 'https://elsewhere.example.test';
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('next page');
    expect(fake.calls.some((c) => c.url.startsWith('https://elsewhere'))).toBe(false);
  });

  it('reports an API error with its status and exits 1', async () => {
    const fake = createFakeGrafana();
    const result = await run([], { ...LIVE_ENV, GRAFANA_TOKEN: 'wrong' }, fake.fetch);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('401');
    expect(result.stderr).not.toContain('wrong');
  });
});

describe('apply.ts on a shared stack: the notification policy is read, merged and written back (GWP#171)', () => {
  const POLICIES = `${STACK_URL}/api/v1/provisioning/policies`;
  const LOUP: Route = { receiver: 'fleet-loup-ops', object_matchers: [['service', '=', 'loup']], group_by: ['creature', 'alertname'] };
  const OTHER: Route = { receiver: 'someone-elses-point', object_matchers: [['team', '=', 'other']] };
  const desiredRoute = () => notificationPolicy().routes![0]!;
  const seed = (fake: ReturnType<typeof createFakeGrafana>, tree: Route) =>
    fake.fetch(POLICIES, { method: 'PUT', headers: { authorization: 'Bearer glsa_test' }, body: JSON.stringify(tree) });
  const tree = async (fake: ReturnType<typeof createFakeGrafana>) => (await (await fake.fetch(POLICIES, { headers: { authorization: 'Bearer glsa_test' } })).json()) as Route;
  const policyPuts = (fake: ReturnType<typeof createFakeGrafana>, from: number) => fake.writes().slice(from).filter((c) => c.url === POLICIES);
  const owned = (t: Route) => (t.routes ?? []).filter((r) => JSON.stringify(r.object_matchers) === JSON.stringify([['team', '=', 'getworkdone']]));

  it('keeps a foreign route in order and a foreign root receiver, and adds exactly one team=getworkdone route', async () => {
    const fake = createFakeGrafana();
    await seed(fake, { receiver: 'fleet-default', group_by: ['grafana_folder', 'alertname'], routes: [LOUP] });
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const after = await tree(fake);
    expect(after.receiver).toBe('fleet-default');
    expect(after.routes).toEqual([LOUP, desiredRoute()]);
    expect(owned(after)).toEqual([desiredRoute()]);
    expect(result.stdout).toContain('notification-policy root: receiver fleet-default is not the stack default, left as is');
  });

  it('replaces a stale team=getworkdone route in place, not duplicated, and drops a second copy', async () => {
    const fake = createFakeGrafana();
    const stale: Route = { ...desiredRoute(), group_by: ['alertname'] };
    await seed(fake, { receiver: 'fleet-default', routes: [LOUP, stale, OTHER, stale] });
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.status).toBe(0);
    const after = await tree(fake);
    expect(after.routes).toEqual([LOUP, desiredRoute(), OTHER]);
    expect(result.stdout).toContain('updated notification-policy root');
  });

  it('treats a route matching team=getworkdone and another label, or with legacy matchers, as foreign', async () => {
    const fake = createFakeGrafana();
    const narrower: Route = { receiver: 'fleet-default', object_matchers: [['team', '=', 'getworkdone'], ['severity', '=', 'critical']] };
    const legacy = { ...desiredRoute(), group_by: ['alertname'], matchers: ['env=x'] } as Route;
    await seed(fake, { receiver: 'fleet-default', routes: [narrower, legacy, LOUP] });
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    expect((await tree(fake)).routes).toEqual([narrower, legacy, LOUP, desiredRoute()]);
  });

  it('a stack whose tree is already merged gets no policy PUT', async () => {
    const fake = createFakeGrafana();
    await seed(fake, { receiver: 'fleet-default', group_by: ['grafana_folder', 'alertname'], routes: [LOUP, desiredRoute(), OTHER] });
    const before = fake.writes().length;
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.status).toBe(0);
    expect(policyPuts(fake, before)).toEqual([]);
    expect(result.stdout).toContain('unchanged notification-policy root');
    const settled = fake.writes().length;
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    expect(fake.writes().slice(settled)).toEqual([]);
  });

  it('sets a default (grafana-default-email) or empty root receiver to getworkdone-oncall and keeps foreign routes', async () => {
    for (const receiver of ['grafana-default-email', '', undefined]) {
      const fake = createFakeGrafana();
      await seed(fake, { receiver, group_by: ['grafana_folder', 'alertname'], routes: [LOUP] });
      const result = await run([], LIVE_ENV, fake.fetch);
      expect(result.status, String(receiver)).toBe(0);
      const after = await tree(fake);
      expect(after.receiver).toBe('getworkdone-oncall');
      expect(after.group_by).toEqual(['grafana_folder', 'alertname']);
      expect(after.routes).toEqual([LOUP, desiredRoute()]);
      expect(result.stdout).not.toContain('left as is');
    }
  });

  it('keeps a getworkdone-oncall root on a shared tree and reports that it catches other tenants\' unmatched alerts', async () => {
    const fake = createFakeGrafana();
    await seed(fake, { receiver: 'getworkdone-oncall', routes: [desiredRoute()] });
    expect((await run([], LIVE_ENV, fake.fetch)).stdout).not.toContain('notification-policy root: receiver');
    await seed(fake, { receiver: 'getworkdone-oncall', routes: [LOUP, desiredRoute()] });
    const before = fake.writes().length;
    const result = await run([], LIVE_ENV, fake.fetch);
    expect(result.status).toBe(0);
    expect(policyPuts(fake, before)).toEqual([]);
    expect((await tree(fake)).receiver).toBe('getworkdone-oncall');
    expect(result.stdout).toContain("notification-policy root: receiver getworkdone-oncall is not the stack default, left as is; it also receives other tenants' alerts that no route matches");
  });

  it('sends back the root timings and nested routes it read, without the provenance field', async () => {
    const fake = createFakeGrafana();
    const nested: Route = { ...LOUP, routes: [{ receiver: 'deep', object_matchers: [['team', '=', 'getworkdone']] }] };
    await seed(fake, { receiver: 'grafana-default-email', group_wait: '10s', routes: [nested], provenance: 'api' } as Route);
    const before = fake.writes().length;
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    const [put] = policyPuts(fake, before);
    expect(put!.body).toEqual({ receiver: 'getworkdone-oncall', group_wait: '10s', routes: [nested, desiredRoute()] });
  });
});

describe('apply.ts --pause (GWP#85)', () => {
  const PAUSE_ENV = { GRAFANA_URL: STACK_URL, GRAFANA_TOKEN: 'glsa_test' };
  const uids = (environment: 'getworkdone' | 'getworkdone-dev') => [...burnRateRules(environment), ...signalRules(environment)].map((r) => r.uid);
  const rule = async (fake: ReturnType<typeof createFakeGrafana>, uid: string) =>
    (await (await fake.fetch(`${STACK_URL}/api/v1/provisioning/alert-rules/${uid}`, { headers: { authorization: 'Bearer glsa_test' } })).json()) as { isPaused?: boolean; title?: string };

  it('pauses all 11 getworkdone-dev rules and no getworkdone rule, sending each rule whole, with no OnCall call', async () => {
    const fake = createFakeGrafana();
    expect((await run([], LIVE_ENV, fake.fetch)).status).toBe(0);
    expect((await run(['--environment', 'getworkdone-dev'], LIVE_ENV, fake.fetch)).status).toBe(0);
    const before = fake.calls.length;
    const result = await run(['--pause', '--environment', 'getworkdone-dev'], PAUSE_ENV, fake.fetch);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const pauseCalls = fake.calls.slice(before);
    expect(pauseCalls.some((c) => c.url.startsWith(ONCALL_URL))).toBe(false);
    const puts = pauseCalls.filter((c) => c.method !== 'GET');
    expect(puts).toHaveLength(11);
    // The provisioning PUT replaces the rule: a body of only isPaused would wipe the query.
    for (const put of puts) {
      expect(put.method).toBe('PUT');
      expect(put.body).toMatchObject({ isPaused: true, title: expect.any(String), data: expect.any(Array), ruleGroup: expect.stringMatching(/^getworkdone-dev-/) });
    }
    expect(uids('getworkdone-dev')).toHaveLength(11);
    for (const uid of uids('getworkdone-dev')) expect((await rule(fake, uid)).isPaused, uid).toBe(true);
    for (const uid of uids('getworkdone')) expect((await rule(fake, uid)).isPaused, uid).toBe(false);
    expect(result.stdout).toContain('paused 11 alert rules of getworkdone-dev');
    // A second pause changes nothing.
    const settled = fake.writes().length;
    expect((await run(['--pause', '--environment', 'getworkdone-dev'], PAUSE_ENV, fake.fetch)).status).toBe(0);
    expect(fake.writes().slice(settled)).toEqual([]);
  });

  it('the next live apply of getworkdone-dev unpauses every rule and reports each updated', async () => {
    const fake = createFakeGrafana();
    expect((await run(['--environment', 'getworkdone-dev'], LIVE_ENV, fake.fetch)).status).toBe(0);
    expect((await run(['--pause', '--environment', 'getworkdone-dev'], PAUSE_ENV, fake.fetch)).status).toBe(0);
    const apply = await run(['--environment', 'getworkdone-dev'], LIVE_ENV, fake.fetch);
    expect(apply.stderr).toBe('');
    expect(apply.status).toBe(0);
    for (const r of burnRateRules('getworkdone-dev')) expect(apply.stdout).toContain(`updated burn-rate-rule ${r.uid}`);
    for (const r of signalRules('getworkdone-dev')) expect(apply.stdout).toContain(`updated signal-rule ${r.uid}`);
    for (const uid of uids('getworkdone-dev')) expect((await rule(fake, uid)).isPaused, uid).toBe(false);
  });

  it('refuses getworkdone, a bare --pause and --pause with --dry-run with exit 2 before any request', async () => {
    for (const args of [['--pause', '--environment', 'getworkdone'], ['--pause'], ['--pause', '--dry-run', '--environment', 'getworkdone-dev']]) {
      const fake = createFakeGrafana();
      const result = await run(args, PAUSE_ENV, fake.fetch);
      expect(result.status, args.join(' ')).toBe(2);
      expect(fake.calls).toEqual([]);
    }
    expect((await run(['--pause', '--environment', 'getworkdone'], PAUSE_ENV, createFakeGrafana().fetch)).stderr).toContain('getworkdone-dev');
  });

  it('needs only GRAFANA_URL and GRAFANA_TOKEN, and exits 2 without either before any request', async () => {
    for (const missing of ['GRAFANA_URL', 'GRAFANA_TOKEN']) {
      const fake = createFakeGrafana();
      const result = await run(['--pause', '--environment', 'getworkdone-dev'], { ...PAUSE_ENV, [missing]: undefined }, fake.fetch);
      expect(result.status, missing).toBe(2);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).not.toContain('GRAFANA_ONCALL');
      expect(fake.calls).toEqual([]);
    }
    const plain = await run(['--pause', '--environment', 'getworkdone-dev'], { ...PAUSE_ENV, GRAFANA_URL: 'http://stack.example.test' }, createFakeGrafana().fetch);
    expect(plain.status).toBe(2);
  });

  it('reports each rule the stack does not hold as absent and creates none', async () => {
    const fake = createFakeGrafana();
    const result = await run(['--pause', '--environment', 'getworkdone-dev'], PAUSE_ENV, fake.fetch);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('absent signal-rule gwd-dev-telemetry-heartbeat');
    expect(fake.writes()).toEqual([]);
  });

  it('exits 1 on an API error or a read-back that is not paused, naming the rule and never the token', async () => {
    const denied = await run(['--pause', '--environment', 'getworkdone-dev'], { ...PAUSE_ENV, GRAFANA_TOKEN: 'wrong' }, createFakeGrafana().fetch);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('401');
    expect(denied.stderr).not.toContain('wrong');
    const fake = createFakeGrafana();
    expect((await run(['--environment', 'getworkdone-dev'], LIVE_ENV, fake.fetch)).status).toBe(0);
    fake.tamper((_path, body) => ({ ...body, isPaused: false }));
    const ignored = await run(['--pause', '--environment', 'getworkdone-dev'], PAUSE_ENV, fake.fetch);
    expect(ignored.status).toBe(1);
    expect(ignored.stderr).toContain('isPaused');
  });
});
