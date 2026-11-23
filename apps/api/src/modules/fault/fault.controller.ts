// The alert drill's routes (GWP#9, docs/runbooks/alert-drill.md), mounted only when
// FAULT_INJECTION_ENABLED=true (app.module.ts). GET /api/v1/__drill is signed in and has no team, so its
// requests count in the /api/v1 API SLOs and never in the capture SLO. POST /api/v1/__fault sets what the
// drill route does next: `errors` fails the next `count` drill requests with 500, `latency` makes every
// drill request wait 1.2 s, `off` clears; either fault lapses after 60 minutes.

import { Body, Controller, Get, HttpCode, InternalServerErrorException, Post, UseGuards } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { parseBody } from '../../common/zod.js';
import { FaultAdminGuard } from './fault-admin.guard.js';
import { FaultState, LATENCY_FAULT_MS, MAX_ERROR_COUNT, type FaultStatus } from './fault.state.js';

const SetFaultRequest = z.strictObject({
  mode: z.enum(['errors', 'latency', 'off']),
  count: z.number().int().min(1).max(MAX_ERROR_COUNT).optional(),
});

@Controller('api/v1')
export class FaultController {
  constructor(private readonly fault: FaultState) {}

  @Get('__drill')
  async drill(): Promise<{ ok: true }> {
    if (this.fault.takeError()) throw new InternalServerErrorException('Injected fault (alert drill)');
    if (this.fault.current() === 'latency') await sleep(LATENCY_FAULT_MS);
    return { ok: true };
  }

  @Post('__fault')
  @HttpCode(200)
  @UseGuards(FaultAdminGuard)
  set(@Body() body: unknown): FaultStatus {
    const { mode, count } = parseBody(SetFaultRequest, body);
    return this.fault.set(mode, count);
  }
}
