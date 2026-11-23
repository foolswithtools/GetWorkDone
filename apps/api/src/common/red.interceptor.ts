// RED interceptor, ported from the exemplar-shop (apps/backend/src/common/red.interceptor.ts @ 12a071e)
// with its status bug fixed. The exemplar read res.statusCode in the RxJS error path (:40, :56-59),
// before the exception filter had set it, so a handler that threw was recorded as 2xx.
//
// Now the interceptor records successful responses once they finish, with their final status. A thrown
// error is recorded by FinalStatusFilter (final-status.filter.ts) after it has decided the status. Both
// claim the request first (red.ts), so each request through a route is recorded exactly once.

import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { recordHttpServerRequest } from '@getworkdone/telemetry';
import type { Request, Response } from 'express';
import { tap, type Observable } from 'rxjs';
import { apiLogger } from './logger.js';
import { claimRecording, isSynthetic, markRequestStart, routeLabel, secondsSinceStart } from './red.js';

@Injectable()
export class RedInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    markRequestStart(req);
    let armed = false;
    return next.handle().pipe(
      tap({
        next: () => {
          if (armed) return;
          armed = true;
          res.once('finish', () => {
            if (!claimRecording(req)) return;
            const route = routeLabel(req);
            const durationSeconds = secondsSinceStart(req);
            const synthetic = isSynthetic(req);
            recordHttpServerRequest({ route, method: req.method, statusCode: res.statusCode, durationSeconds, synthetic });
            apiLogger.info({ route, method: req.method, status_code: res.statusCode, synthetic, duration_ms: Math.round(durationSeconds * 1000) }, 'request');
          });
        },
      }),
    );
  }
}
