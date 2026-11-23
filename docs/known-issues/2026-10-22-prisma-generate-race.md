# Two prisma generate runs raced in pnpm typecheck

Resolved before merge, GWP#7. Found by CI on the PR: `@getworkdone/db#typecheck` failed with `ENOENT: no such file or directory, open '.../packages/db/src/generated/prisma/models/Team.ts'`.

Both `typecheck` and `build` in `packages/db` start with `prisma generate`, which rewrites `src/generated/prisma`. `pnpm typecheck` runs `turbo run typecheck`. Every other package's `typecheck` depends on `^build`, so turbo also runs `@getworkdone/db#build`. Nothing ordered that build against `@getworkdone/db#typecheck`, so the two could generate into the same directory at once, and one removed files the other was reading. The race was there before GWP#7. The sixth workspace package that GWP#7 added changed turbo's scheduling enough to make it happen in CI.

Fix: `turbo.json` makes `@getworkdone/db#typecheck` depend on `@getworkdone/db#build`, so the two never overlap.

Regression test: `tests/scripts/turbo-config.test.ts`, "never runs two @getworkdone/db tasks that call prisma generate at the same time".
