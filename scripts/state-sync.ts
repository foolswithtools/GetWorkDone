// Keeps the generated slice-status block in docs/context/STATE.md in step with docs/ROADMAP.md (P6:
// STATE.md holds decisions and links only; the roadmap owns status). The block sits between the
// state-sync markers and is rewritten from the roadmap's table rows.
//
//   pnpm exec tsx scripts/state-sync.ts           rewrite the block
//   pnpm exec tsx scripts/state-sync.ts --check   exit 1 if it drifted (run by `pnpm lint`)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BEGIN = '<!-- state-sync:begin -->';
const END = '<!-- state-sync:end -->';
const STATUSES = new Set(['planned', 'in-progress', 'done']);
const ROW = /^\|\s*\[#(\d+)\]\(([^)\s]+)\)\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*$/;

export interface RoadmapRow {
  issue: number;
  url: string;
  title: string;
  status: string;
}

/** The roadmap table's slice rows, in order. */
export function parseRoadmap(text: string): RoadmapRow[] {
  return text.split('\n').flatMap((line) => {
    const [, issue, url, title, status] = ROW.exec(line.trim()) ?? [];
    return issue && url && title && status ? [{ issue: Number(issue), url, title, status }] : [];
  });
}

function renderBlock(rows: readonly RoadmapRow[]): string {
  return [
    BEGIN,
    '<!-- Generated from docs/ROADMAP.md by scripts/state-sync.ts; edit the roadmap, not this block. -->',
    '| Slice | Status |',
    '|---|---|',
    ...rows.map((row) => `| [#${row.issue}](${row.url}) | ${row.status} |`),
    END,
  ].join('\n');
}

/** `state` with its generated block rebuilt from `roadmap`. Throws on markers, statuses or no rows. */
export function syncState(state: string, roadmap: string): string {
  const rows = parseRoadmap(roadmap);
  if (rows.length === 0) throw new Error('docs/ROADMAP.md has no slice rows');
  for (const row of rows) if (!STATUSES.has(row.status)) throw new Error(`#${row.issue}: unknown status "${row.status}"`);
  const begin = state.indexOf(BEGIN);
  const end = state.indexOf(END);
  if (begin === -1 || end < begin) throw new Error(`STATE.md lacks the ${BEGIN} ... ${END} markers`);
  return state.slice(0, begin) + renderBlock(rows) + state.slice(end + END.length);
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function main(args: readonly string[]): number {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const statePath = resolve(argValue(args, '--state') ?? resolve(root, 'docs/context/STATE.md'));
  const roadmapPath = resolve(argValue(args, '--roadmap') ?? resolve(root, 'docs/ROADMAP.md'));
  try {
    const state = readFileSync(statePath, 'utf8');
    const next = syncState(state, readFileSync(roadmapPath, 'utf8'));
    if (args.includes('--check')) {
      if (next !== state) {
        process.stderr.write(`state-sync: ${statePath} drifted from ${roadmapPath}; run pnpm exec tsx scripts/state-sync.ts\n`);
        return 1;
      }
      process.stdout.write('state-sync: in sync\n');
      return 0;
    }
    if (next !== state) writeFileSync(statePath, next);
    process.stdout.write(next === state ? 'state-sync: in sync\n' : `state-sync: rewrote ${statePath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`state-sync: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
