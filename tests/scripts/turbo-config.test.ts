import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envNamesReadByCode } from './env-names.ts';

interface Task {
  dependsOn?: string[];
  passThroughEnv?: string[];
}

const turbo = JSON.parse(readFileSync(new URL('../../turbo.json', import.meta.url), 'utf8')) as { tasks: Record<string, Task> };
const dbScripts = (JSON.parse(readFileSync(new URL('../../packages/db/package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The tasks `pkg#task` must wait for: its own override if there is one, else the generic task's. */
function dependsOn(pkg: string, task: string): string[] {
  return (turbo.tasks[`${pkg}#${task}`] ?? turbo.tasks[task])?.dependsOn ?? [];
}

// CI failed on GWP#7's PR with ENOENT on src/generated/prisma/models/Team.ts: db#typecheck and db#build
// (pulled in by the other packages' typecheck through ^build) ran `prisma generate` into the same
// directory at the same time (docs/known-issues/2026-10-22-prisma-generate-race.md).
describe('turbo task graph', () => {
  it('never runs two @getworkdone/db tasks that call prisma generate at the same time', () => {
    const generating = Object.keys(turbo.tasks)
      .map((key) => key.split('#').at(-1)!)
      .filter((task, index, all) => all.indexOf(task) === index && (dbScripts[task] ?? '').includes('prisma generate'));
    expect(generating.sort()).toEqual(['build', 'typecheck']);
    for (const a of generating) {
      for (const b of generating) {
        if (a >= b) continue;
        const ordered = dependsOn('@getworkdone/db', a).includes(`@getworkdone/db#${b}`) || dependsOn('@getworkdone/db', b).includes(`@getworkdone/db#${a}`);
        expect(ordered, `@getworkdone/db#${a} and #${b} both run prisma generate and must not run in parallel`).toBe(true);
      }
    }
  });

  // Turbo 2 runs tasks in strict env mode: a variable not declared for a task never reaches it, so
  // `DATABASE_URL=... OIDC_ISSUER_URL=... pnpm dev` ran the API with none of them and /auth/login
  // answered 503 (docs/known-issues/2026-11-22-pnpm-dev-drops-env.md).
  it('passes every variable the API reads through to pnpm dev', () => {
    const patterns = turbo.tasks.dev?.passThroughEnv ?? [];
    const covered = (name: string) => patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
    const names = [...envNamesReadByCode()];
    expect(names).toEqual(expect.arrayContaining(['DATABASE_URL', 'OIDC_ISSUER_URL', 'QUOTA_WORK_TYPES_PER_TEAM', 'OTEL_SDK_DISABLED']));
    expect(names.filter((name) => !covered(name))).toEqual([]);
  });
});
