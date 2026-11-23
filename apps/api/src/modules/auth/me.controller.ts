import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { MeResponse } from '@getworkdone/contracts';
import type { Request } from 'express';
import { requireIdentity, sessionOf } from '../../common/identity.js';
import { Database } from '../database/database.js';
import type { R4cSigner } from '../r4c/signing-key.js';
import { R4C_SIGNER } from '../r4c/signer.js';

@Controller('api/v1/me')
export class MeController {
  constructor(private readonly db: Database, @Inject(R4C_SIGNER) private readonly r4c: R4cSigner | null) {}

  /** The signed-in identity, the CSRF token the SPA sends on writes, the teams it belongs to, and r4c when configured (GWP#10). */
  @Get()
  async me(@Req() req: Request): Promise<MeResponse> {
    const identity = requireIdentity(req);
    const memberships = await this.db.client.teamMember.findMany({
      where: { subject: identity.subject },
      include: { team: true },
      orderBy: [{ team: { createdAt: 'asc' } }, { teamId: 'asc' }],
    });
    return {
      subject: identity.subject,
      email: identity.email ?? '',
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      csrfToken: sessionOf(req)?.csrfToken ?? '',
      teams: memberships.map((m) => ({ id: m.team.id, name: m.team.name, role: m.role })),
      ...(this.r4c ? { r4c: { appId: this.r4c.appId } } : {}),
    };
  }
}
