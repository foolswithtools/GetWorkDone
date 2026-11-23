import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthResponse, ReadyResponse } from '@getworkdone/contracts';
import { Readiness } from './readiness.js';

@Controller()
export class HealthController {
  constructor(private readonly readiness: Readiness) {}

  /** Liveness for the ALB target group and the smoke test: no dependencies are checked. */
  @Get('healthz')
  health(): HealthResponse {
    return HealthResponse.parse({ status: 'ok' });
  }

  /**
   * Readiness (GWP#53): whether the database answers SELECT 1 within 2 s, from a result under 30 s old.
   * Open, like /healthz (the deny-by-default guard covers /api/v1 only), and it reveals one bit. Not the
   * ALB health check: a database outage must not restart every task (docs/deploy/sandbox.md).
   */
  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    if (await this.readiness.current()) return ReadyResponse.parse({ status: 'ok', database: 'ok' });
    res.status(503);
    return ReadyResponse.parse({ status: 'degraded', database: 'down' });
  }
}
