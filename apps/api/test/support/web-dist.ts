import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A stand-in for apps/web/dist: an index.html and one asset. */
export function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gwd-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>GetWorkDone</title><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
  return dir;
}
