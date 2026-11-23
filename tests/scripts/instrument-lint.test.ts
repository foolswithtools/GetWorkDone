import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lint, main } from '../../scripts/instrument-lint.js';
import { runMain } from './support.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/instrument-lint.ts');

// A copy of apps/api/src that each test can break.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lint-'));
  cpSync(join(root, 'apps/api/src'), join(dir, 'apps/api/src'), { recursive: true });
  return dir;
}

function edit(dir: string, file: string, from: string | RegExp, to: string): void {
  const path = join(dir, 'apps/api/src', file);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(from, to);
  if (next === text) throw new Error(`fixture edit did not apply to ${file}`);
  writeFileSync(path, next);
}

describe('instrument-lint', () => {
  it('passes the repo as it is', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: root, encoding: 'utf8' });
    expect(result.stdout).toContain('instrument-lint: ok');
    expect(result.status).toBe(0);
    expect(lint(root)).toEqual([]);
  });

  it('fails when the RED interceptor or the final status filter is not registered globally', () => {
    const dir = fixture();
    edit(dir, 'common/common.module.ts', '{ provide: APP_INTERCEPTOR, useClass: RedInterceptor },', '');
    edit(dir, 'common/common.module.ts', '{ provide: APP_FILTER, useClass: FinalStatusFilter },', '');
    expect(lint(dir)).toEqual([
      'apps/api/src/common: RedInterceptor must be registered as APP_INTERCEPTOR',
      'apps/api/src/common: FinalStatusFilter must be registered as APP_FILTER',
    ]);
    const result = runMain(main, ['--root', dir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL apps/api/src/common: RedInterceptor must be registered as APP_INTERCEPTOR');
    expect(runMain(main, []).status).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it('fails when the filter stops recording RED or logging route and status_code', () => {
    const dir = fixture();
    edit(dir, 'common/final-status.filter.ts', 'recordHttpServerRequest({ route, method: req.method, statusCode, durationSeconds, synthetic });', '');
    edit(dir, 'common/final-status.filter.ts', /status_code: statusCode, /, '');
    edit(dir, 'common/red.interceptor.ts', /const route = routeLabel\(req\);\n\s*/, '');
    edit(dir, 'common/red.interceptor.ts', /\{ route, method/g, '{ path: routeLabel(req), method');
    expect(lint(dir)).toEqual([
      'apps/api/src/common/red.interceptor.ts: must log route',
      'apps/api/src/common/final-status.filter.ts: must call recordHttpServerRequest',
      'apps/api/src/common/final-status.filter.ts: must log status_code',
    ]);
  });

  it('fails when common/ no longer imports @getworkdone/telemetry, or a file is missing', () => {
    const dir = fixture();
    rmSync(join(dir, 'apps/api/src/common/red.interceptor.ts'));
    edit(dir, 'common/final-status.filter.ts', "import { recordHttpServerRequest } from '@getworkdone/telemetry';", '');
    edit(dir, 'common/logger.ts', "import { createLogger, otelOptionsFromEnv, type Logger } from '@getworkdone/telemetry';", '');
    expect(lint(dir)).toEqual(expect.arrayContaining([
      'apps/api/src/common: no file imports @getworkdone/telemetry',
      'apps/api/src/common/red.interceptor.ts: missing',
    ]));
  });

  it('a module that makes outbound HTTP calls must wrap them in withSpan', () => {
    const dir = fixture();
    const file = join(dir, 'apps/api/src/modules/health/client.ts');
    writeFileSync(file, "export async function ping(): Promise<number> {\n  return (await fetch('https://example.test')).status;\n}\n");
    writeFileSync(join(dir, 'apps/api/src/modules/health/axios-user.ts'), "import axios from 'axios';\nexport const get = () => axios.get('/x');\n");
    expect(lint(dir)).toEqual([
      'apps/api/src/modules/health/axios-user.ts: makes outbound HTTP calls without withSpan',
      'apps/api/src/modules/health/client.ts: makes outbound HTTP calls without withSpan',
    ]);
    writeFileSync(file, "import { withSpan } from '@getworkdone/telemetry';\nexport const ping = () => withSpan('ping', async () => (await fetch('https://example.test')).status);\n");
    expect(lint(dir)).toEqual(['apps/api/src/modules/health/axios-user.ts: makes outbound HTTP calls without withSpan']);
  });

  it('every fetch call must be inside a withSpan callback, not only in a file that calls withSpan (GWP#6)', () => {
    const dir = fixture();
    // The webhook POST moved out of its withSpan into a helper method: the file still calls withSpan.
    const path = join(dir, 'apps/api/src/modules/distribute/webhook.adapter.ts');
    const post = /response = await (\(this\.options\.fetch \?.*\));\n/.exec(readFileSync(path, 'utf8'))?.[1];
    expect(post).toBeDefined();
    edit(dir, 'modules/distribute/webhook.adapter.ts', `response = await ${post!};`, 'response = await this.send(url, init);');
    edit(dir, 'modules/distribute/webhook.adapter.ts', /\n {2}\/\*\*\n {3}\* Undefined when every address/, `\n  private send(url: URL, init: RequestInit): Promise<Response> {\n    return ${post!};\n  }\n\n  /**\n   * Undefined when every address`);
    const problems = lint(dir);
    expect(problems).toEqual([
      expect.stringMatching(/^apps\/api\/src\/modules\/distribute\/webhook\.adapter\.ts:\d+: this\.options\.fetch\(\) is called outside withSpan$/),
      expect.stringMatching(/^apps\/api\/src\/modules\/distribute\/webhook\.adapter\.ts:\d+: fetch\(\) is called outside withSpan$/),
    ]);
    const result = runMain(main, ['--root', dir]);
    expect(result.status).toBe(1);

    // A fetch in a function passed to withSpan is inside it, however deeply nested.
    const file = join(dir, 'apps/api/src/modules/health/nested.ts');
    writeFileSync(file, "import { withSpan } from '@getworkdone/telemetry';\nexport const ping = (u: string) => withSpan('ping', async () => { const go = async () => (await fetch(u)).status; return go(); });\n");
    expect(lint(dir)).not.toContain(expect.stringContaining('nested.ts'));
    // withSpan's name argument is not its callback: a fetch there is outside.
    writeFileSync(file, "import { withSpan } from '@getworkdone/telemetry';\nexport const ping = async (u: string) => withSpan(String((await fetch(u)).status), async () => 1);\n");
    expect(lint(dir)).toContain('apps/api/src/modules/health/nested.ts:2: fetch() is called outside withSpan');
    rmSync(dir, { recursive: true });
  });
});
