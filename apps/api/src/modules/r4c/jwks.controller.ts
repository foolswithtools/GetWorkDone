import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { R4cPublicJwk, R4cSigner } from './signing-key.js';
import { R4C_SIGNER } from './signer.js';

/**
 * GET /.well-known/r4c-jwks.json (GWP#10): the public key edge and control verify assertions against,
 * or no key when R4C_SIGNING_KEY is unset. Open (outside /api/v1). Cached 300 s; a rotated key gets a
 * new kid, and edge and control refetch on an unknown kid (docs/r4c.md).
 */
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(R4C_SIGNER) private readonly signer: R4cSigner | null) {}

  @Get('r4c-jwks.json')
  @Header('cache-control', 'public, max-age=300')
  jwks(): { keys: R4cPublicJwk[] } {
    return { keys: this.signer ? [this.signer.publicJwk] : [] };
  }
}
