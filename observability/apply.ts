// Apply GetWorkDone's observability as code to the owner's Grafana Cloud stack (GWP#7, D-027, D-042).
//
//   pnpm --filter @getworkdone/observability exec tsx apply.ts --dry-run [--environment <env>]
//   pnpm --filter @getworkdone/observability exec tsx apply.ts [--environment <env>]
//   pnpm --filter @getworkdone/observability exec tsx apply.ts --pause --environment getworkdone-dev
//
// --dry-run prints the plan and sends nothing. Live mode creates or updates each object, reads every one
// back and exits 1 on any mismatch; a second run changes nothing. <env> is getworkdone (default) or
// getworkdone-dev: each run provisions that environment's SLOs, burn-rate rules, signal rules and dashboard, plus the
// shared OnCall objects, contact point, folder and policy tree.
//
// --pause (GWP#85) pauses every alert rule of getworkdone-dev's two groups, so a destroyed dev
// (destroy.yml) does not page from its telemetry heartbeat. It refuses getworkdone (destroy.yml refuses
// prod, D-084), needs only GRAFANA_URL and GRAFANA_TOKEN, and sends each rule whole, as live mode builds
// it but with isPaused: true, because the provisioning PUT replaces the rule. A rule the stack does not
// hold is reported absent. The next live apply sets isPaused: false again, so the rules come back with
// the instance. The body is the repo's, not the stack's copy: it is the shape apply.ts already PUTs, and
// the deploy that brings dev back applies the same definitions anyway.
//
// Live mode reads (docs/observability.md, "Credentials"):
//   GRAFANA_URL                  the stack, https://<stack>.grafana.net
//   GRAFANA_TOKEN                a stack service-account token
//   GRAFANA_ONCALL_URL           the OnCall API URL (IRM > Settings > Admin & API)
//   GRAFANA_ONCALL_OWNER         the owner's Grafana login, the OnCall team's first member
//   GRAFANA_PROM_DATASOURCE_UID  optional; defaults to grafanacloud-prom
// A missing one exits 2 before any request; --pause reads only the first two and the datasource.
//
// Exit codes: 0 applied and verified (or planned), 1 a request failed or a read-back differed, 2 usage.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyAlerting, planAlerting } from './alerting/apply.js';
import { applyDashboards, planDashboards } from './dashboards/apply.js';
import { DEFAULT_DATASOURCE_UID } from './lib/datasource.js';
import { ENVIRONMENTS, isEnvironment, type Environment } from './lib/environment.js';
import { createClient, GrafanaApiError, type GrafanaClient } from './lib/grafana-client.js';
import { ApplyError, Mismatch, reconcile, type Report } from './lib/reconcile.js';
import { applyOncall, planOncall } from './oncall/apply.js';
import { applySignals, planSignals } from './signals/apply.js';
import { signalRules, toSignalAlertRule } from './signals/definitions.js';
import { applySlos, planSlos } from './slo/apply.js';
import { burnRateRules, sloDefinitions, toAlertRule } from './slo/definitions.js';
import { dashboards } from './dashboards/definitions.js';

export interface ApplyDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const REQUIRED = ['GRAFANA_URL', 'GRAFANA_TOKEN', 'GRAFANA_ONCALL_URL', 'GRAFANA_ONCALL_OWNER'] as const;

/** The only environment --pause acts on: the one destroy.yml destroys. */
const PAUSABLE: Environment = 'getworkdone-dev';

class UsageError extends Error {}

function parseArgs(args: readonly string[]): { dryRun: boolean; pause: boolean; environment: Environment } {
  let dryRun = false;
  let pause = false;
  let environment: string = 'getworkdone';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--pause') pause = true;
    else if (arg === '--environment') environment = args[++i] ?? '';
    else throw new UsageError(`unknown argument ${String(arg)}`);
  }
  if (!isEnvironment(environment)) throw new UsageError(`--environment must be one of ${ENVIRONMENTS.join(', ')}, not ${JSON.stringify(environment)}`);
  if (pause && dryRun) throw new UsageError('--pause and --dry-run do not go together');
  if (pause && environment !== PAUSABLE) throw new UsageError(`--pause acts only on --environment ${PAUSABLE}, not ${environment}`);
  return { dryRun, pause, environment };
}

/** Pause every rule of the environment's two groups (GWP#85); the next live apply unpauses them. */
async function pauseRules(grafana: GrafanaClient, environment: Environment, datasourceUid: string, report: Report): Promise<number> {
  const rules = [
    ...burnRateRules(environment).map((r) => ({ kind: 'burn-rate-rule', body: toAlertRule(r, datasourceUid) })),
    ...signalRules(environment).map((r) => ({ kind: 'signal-rule', body: toSignalAlertRule(r, datasourceUid) })),
  ];
  let paused = 0;
  for (const { kind, body } of rules) {
    const path = `/api/v1/provisioning/alert-rules/${body.uid}`;
    const desired = { ...body, isPaused: true };
    // A rule the stack does not hold cannot page; creating it here would only add one to delete.
    if ((await grafana.get(path)) === undefined) {
      report(`absent ${kind} ${body.uid}`);
      continue;
    }
    await reconcile(
      {
        kind,
        name: body.uid,
        desired: { isPaused: true },
        read: () => grafana.get(path),
        create: () => Promise.reject(new ApplyError(`${kind} ${body.uid}: gone before it could be paused`)),
        update: () => grafana.put(path, desired),
      },
      (line) => report(line.replace(/^updated /, 'paused ')),
    );
    paused++;
  }
  return paused;
}

function summary(environment: Environment): string {
  const burn = burnRateRules(environment).length;
  const signals = signalRules(environment).length;
  return (
    `${sloDefinitions(environment).length} SLOs, ${burn} burn-rate rules, ${signals} signal rules ` +
    `(${burn + signals} alert rules in 2 groups (${environment}-slo-burn, ${environment}-signals)), 1 contact point, ${dashboards(environment).length} dashboard`
  );
}

function httpsUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:') throw new UsageError(`${name} must be an https URL`);
  return value.replace(/\/+$/, '');
}

export async function main(args: readonly string[], deps: ApplyDeps): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(args);
  } catch (error) {
    deps.stderr(`apply: ${(error as Error).message}\n`);
    return 2;
  }
  const { environment } = options;

  if (options.pause) {
    const { GRAFANA_URL, GRAFANA_TOKEN } = deps.env;
    if (!GRAFANA_URL || !GRAFANA_TOKEN) {
      const missing = (['GRAFANA_URL', 'GRAFANA_TOKEN'] as const).filter((name) => !deps.env[name]);
      deps.stderr(`apply: --pause needs ${missing.join(', ')} (docs/observability.md, "Credentials")\n`);
      return 2;
    }
    let stackUrl: string;
    try {
      stackUrl = httpsUrl('GRAFANA_URL', GRAFANA_URL);
    } catch (error) {
      deps.stderr(`apply: ${(error as Error).message}\n`);
      return 2;
    }
    const grafana = createClient({ baseUrl: stackUrl, token: GRAFANA_TOKEN, fetch: deps.fetch });
    deps.stdout(`pause for environment ${environment} at ${stackUrl}\n`);
    try {
      const paused = await pauseRules(grafana, environment, deps.env.GRAFANA_PROM_DATASOURCE_UID || DEFAULT_DATASOURCE_UID, (line) => deps.stdout(`  ${line}\n`));
      deps.stdout(`paused ${paused} alert rules of ${environment} (${environment}-slo-burn, ${environment}-signals); the next live apply unpauses them\n`);
    } catch (error) {
      const known = error instanceof GrafanaApiError || error instanceof Mismatch || error instanceof ApplyError;
      deps.stderr(`apply: ${known ? '' : 'request failed: '}${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return 0;
  }

  if (options.dryRun) {
    deps.stdout(`plan for environment ${environment} (dry run: no requests)\n`);
    for (const line of [...planOncall(), ...planAlerting(), ...planSlos(environment), ...planSignals(environment), ...planDashboards(environment)]) deps.stdout(`  ${line}\n`);
    deps.stdout(`${summary(environment)}\n`);
    return 0;
  }

  const credentials: Partial<Record<(typeof REQUIRED)[number], string>> = {};
  for (const name of REQUIRED) if (deps.env[name]) credentials[name] = deps.env[name];
  const { GRAFANA_URL, GRAFANA_TOKEN, GRAFANA_ONCALL_URL, GRAFANA_ONCALL_OWNER } = credentials;
  const missing = REQUIRED.filter((name) => !credentials[name]);
  if (!GRAFANA_URL || !GRAFANA_TOKEN || !GRAFANA_ONCALL_URL || !GRAFANA_ONCALL_OWNER) {
    deps.stderr(`apply: live mode needs ${missing.join(', ')} (docs/observability.md, "Credentials"); use --dry-run to plan without them\n`);
    return 2;
  }
  let stackUrl: string;
  let oncallUrl: string;
  try {
    stackUrl = httpsUrl('GRAFANA_URL', GRAFANA_URL);
    oncallUrl = httpsUrl('GRAFANA_ONCALL_URL', GRAFANA_ONCALL_URL);
  } catch (error) {
    deps.stderr(`apply: ${(error as Error).message}\n`);
    return 2;
  }
  const token = GRAFANA_TOKEN;
  const datasourceUid = deps.env.GRAFANA_PROM_DATASOURCE_UID || DEFAULT_DATASOURCE_UID;
  const grafana = createClient({ baseUrl: stackUrl, token, fetch: deps.fetch });
  const oncall = createClient({ baseUrl: oncallUrl, token, fetch: deps.fetch, auth: 'bare', headers: { 'x-grafana-url': stackUrl } });
  let objects = 0;
  const report = (line: string) => {
    objects++;
    deps.stdout(`  ${line}\n`);
  };

  deps.stdout(`apply for environment ${environment} to ${stackUrl}\n`);
  try {
    const { integrationLink } = await applyOncall({ grafana, oncall, ownerLogin: GRAFANA_ONCALL_OWNER, report });
    await applyAlerting({ grafana, report }, integrationLink);
    await applySlos({ grafana, environment, datasourceUid, report });
    await applySignals({ grafana, environment, datasourceUid, report });
    await applyDashboards({ grafana, environment, datasourceUid, report });
  } catch (error) {
    // API errors, read-back mismatches, unmet preconditions and network failures all stop the run.
    const known = error instanceof GrafanaApiError || error instanceof Mismatch || error instanceof ApplyError;
    deps.stderr(`apply: ${known ? '' : 'request failed: '}${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  deps.stdout(`verified ${objects} objects for ${environment}: ${summary(environment)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`apply: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
