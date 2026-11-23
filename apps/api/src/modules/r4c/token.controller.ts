import { Controller, Get, Header, Inject, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { requireIdentity } from '../../common/identity.js';
import { Database } from '../database/database.js';
import type { R4cSigner } from './signing-key.js';
import { R4C_SIGNER } from './signer.js';

/**
 * GET /api/v1/r4c/token, the widget's token-url (GWP#10). Under /api/v1, so the deny-by-default guard
 * answers a JSON 401 before this runs when there is no session, and the widget's `redirect: 'error'`
 * never meets a redirect. `roles` are the subject's distinct team roles, sorted; team ids stay out.
 */
@Controller('api/v1/r4c')
export class TokenController {
  constructor(@Inject(R4C_SIGNER) private readonly signer: R4cSigner | null, private readonly db: Database) {}

  @Get('token')
  @Header('cache-control', 'no-store')
  async token(@Req() req: Request): Promise<{ token: string }> {
    if (!this.signer) throw new ServiceUnavailableException({ error: 'r4c_not_configured' });
    const identity = requireIdentity(req);
    const rows = await this.db.client.teamMember.findMany({ where: { subject: identity.subject }, select: { role: true }, distinct: ['role'] });
    const roles = rows.map((r) => r.role as string).sort();
    return { token: await this.signer.mint({ sub: identity.subject, email: identity.email ?? '', roles }) };
  }
}
