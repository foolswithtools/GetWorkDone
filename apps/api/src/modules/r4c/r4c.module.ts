// request-4-change's requester assertion (GWP#10, docs/r4c.md): the token route the widget's token-url
// calls, the key set edge and control verify it against, and the signer GET /api/v1/me reads to tell the
// SPA whether to embed the widget. Global, so MeController (AuthModule) can inject the signer; also
// listed in AppModule ahead of SpaModule, whose catch-all would otherwise answer the key set's path.

import { Global, Module, type DynamicModule } from '@nestjs/common';
import { JwksController } from './jwks.controller.js';
import { loadSigner, type R4cOptions } from './signing-key.js';
import { R4C_SIGNER } from './signer.js';
import { TokenController } from './token.controller.js';

@Global()
@Module({})
export class R4cModule {
  static forRoot(options: R4cOptions): DynamicModule {
    return {
      module: R4cModule,
      controllers: [TokenController, JwksController],
      // A key that does not parse stops startup here (createApp rejects), naming the variable only.
      providers: [{ provide: R4C_SIGNER, useFactory: () => (options.signingKey ? loadSigner(options.signingKey, options.appId) : null) }],
      exports: [R4C_SIGNER],
    };
  }
}
