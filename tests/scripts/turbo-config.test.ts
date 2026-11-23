import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Task {
  dependsOn?: string[];
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
});
