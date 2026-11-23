// The final exception filter: every error that leaves a handler, a guard or Nest's router ends here.
// It lets Nest's BaseExceptionFilter write the response (HttpException status, else 500), then records
// RED with the status actually sent. This is the status fix for the exemplar's interceptor
// (red.interceptor.ts:40, :56-59 @ 12a071e): a thrown 500 is recorded as 5xx, never 2xx
// (prebutton.md:346), and errors raised before any interceptor runs (no route, guards) are recorded too.

import { Catch, HttpException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { recordHttpServerRequest } from '@getworkdone/telemetry';
import type { Request, Response } from 'express';
import { apiLogger } from './logger.js';
import { claimRecording, isSynthetic, routeLabel, secondsSinceStart } from './red.js';

@Catch()
export class FinalStatusFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(exception, host);
    if (host.getType() !== 'http') return;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (!claimRecording(req)) return;
    // BaseExceptionFilter has set the status by now; fall back to what it would have chosen.
    const statusCode = res.headersSent ? res.statusCode : exception instanceof HttpException ? exception.getStatus() : 500;
    const route = routeLabel(req);
    const durationSeconds = secondsSinceStart(req);
    const synthetic = isSynthetic(req);
    recordHttpServerRequest({ route, method: req.method, statusCode, durationSeconds, synthetic });
    const fields = { route, method: req.method, status_code: statusCode, synthetic, duration_ms: Math.round(durationSeconds * 1000) };
    if (statusCode >= 500) apiLogger.error({ ...fields, err: exception }, 'request failed');
    else apiLogger.info(fields, 'request');
  }
}
