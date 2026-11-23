// The SPA fallback: index.html for any GET no other route matched, so client-side routes load the
// app. It never answers under /api/ (the API) or /__r4c/ (the request-4-change edge sidecar's path
// route, D-018), nor for a missing file such as /assets/x.js: those are the API's JSON 404. A repeated
// leading slash (//api/v1/me, GWP#15), a percent-escape, a dot segment or a backslash (/%2Fapi/v1/me,
// /x/../api/v1/me, /\api/v1/me, GWP#30) does not take a path out of /api or /__r4c.
//
// It is a Nest route, registered after every other module, rather than @nestjs/serve-static's
// fallback, which turned body-parser errors on excluded paths (400, 413) into 404s.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Controller, Get, Header, Inject, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';
import { matchesPath } from '../common/path.js';

export const WEB_DIST_DIR = Symbol('WEB_DIST_DIR');

/** The catch-all route pattern (Express 5 syntax). */
export const SPA_ROUTE = '/{*path}';

/** True for paths the SPA must never answer: /api, /__r4c and anything under them, as sent or once resolved (matchesPath). */
export function isReservedPath(path: string): boolean {
  return matchesPath(/^\/(?:api|__r4c)(?:\/|$)/i, path);
}

@Controller()
export class SpaController {
  constructor(@Inject(WEB_DIST_DIR) private readonly webDistDir: string) {}

  @Get(SPA_ROUTE)
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-cache')
  async index(@Req() req: Request): Promise<string> {
    const last = req.path.split('/').pop() ?? '';
    if (isReservedPath(req.path) || last.includes('.')) throw new NotFoundException(`Cannot GET ${req.path}`);
    try {
      return await readFile(join(this.webDistDir, 'index.html'), 'utf8');
    } catch {
      throw new NotFoundException('The SPA is not built (apps/web/dist)');
    }
  }
}
