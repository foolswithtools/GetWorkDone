import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CaptureModule } from './modules/capture/capture.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { DatabaseModule } from './modules/database/database.js';
import { DistributeModule } from './modules/distribute/distribute.module.js';
import { FaultModule } from './modules/fault/fault.module.js';
import type { FaultOptions } from './modules/fault/fault.state.js';
import type { DistributeOptions } from './modules/distribute/distribute.options.js';
import type { QuotaOptions } from './common/quota.js';
import { HealthModule } from './modules/health/health.module.js';
import { ItemsModule } from './modules/items/items.module.js';
import { ProcessModule } from './modules/process/process.module.js';
import { R4cModule } from './modules/r4c/r4c.module.js';
import type { R4cOptions } from './modules/r4c/signing-key.js';
import { TeamsModule } from './modules/teams/teams.module.js';
import { WorkTypesModule } from './modules/work-types/work-types.module.js';
import { SpaModule } from './spa/spa.module.js';

export interface AppModuleOptions {
  /** The built SPA (apps/web/dist); index.html is the fallback for client-side routes. */
  webDistDir: string;
  /** Extra modules, for tests that mount their own controllers. */
  extraModules?: Type[];
  /** Distribution's receiver, mail transport and clock, for tests; production reads the environment. */
  distribute?: DistributeOptions;
  /** Quota limits and clock, for tests; production reads the environment, and tests enforce none without these (GWP#50). The clock defaults to `distribute.now` (GWP#74). */
  quotas?: QuotaOptions;
  /** The drill and fault routes (GWP#9); mounted only when `enabled`, as FAULT_INJECTION_ENABLED=true does on dev. */
  fault?: FaultOptions;
  /** request-4-change's signing key and app id (GWP#10); production reads R4C_SIGNING_KEY and GETWORKDONE_ENVIRONMENT. */
  r4c?: R4cOptions;
}

@Module({})
export class AppModule {
  static forRoot({ webDistDir, extraModules = [], distribute, quotas, fault, r4c = { appId: 'local' } }: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      // SpaModule last: Nest registers routes in module order, and its catch-all must come after
      // every API route. AuthModule is listed here although CommonModule imports it: a module reached
      // only through another's imports registers its routes after all of these, behind the catch-all.
      // R4cModule too, for /.well-known/r4c-jwks.json: the catch-all answers 404 for a last segment with a dot.
      // Without the fault flag the FaultModule is not imported at all, so its routes do not exist.
      imports: [
        IdentityModule, CommonModule.forRoot(quotas, distribute?.now), DatabaseModule, HealthModule, AuthModule, TeamsModule, WorkTypesModule, ItemsModule, CaptureModule, ProcessModule, DistributeModule.forRoot(distribute), R4cModule.forRoot(r4c),
        ...(fault?.enabled ? [FaultModule.forRoot(fault)] : []),
        ...extraModules,
        SpaModule.forRoot(webDistDir),
      ],
    };
  }
}
