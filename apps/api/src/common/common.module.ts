// Cross-cutting API wiring (scripts/instrument-lint.ts checks it): the RED interceptor and the final
// status filter, registered globally for every Nest route (the API and the SPA fallback; built files
// served by the static middleware are not counted), and the global guards. Nest runs global guards in
// the order they are registered here: authentication and deny-by-default (401), then CSRF (403), then
// team membership and role (403). auth.integration.test.ts pins that order. It also provides the quota
// limiter (quota.ts, GWP#50), globally, so @TakeQuota on any controller and the delivery worker reach it.

import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../modules/auth/auth.module.js';
import { Database } from '../modules/database/database.js';
import { CsrfGuard } from './csrf.guard.js';
import { DenyByDefaultGuard } from './deny-by-default.guard.js';
import { FinalStatusFilter } from './final-status.filter.js';
import { QuotaGuard, QuotaLimiter, quotaLimiter, type QuotaOptions } from './quota.js';
import { RedInterceptor } from './red.interceptor.js';
import { TeamMemberGuard } from './team-member.guard.js';

@Module({})
export class CommonModule {
  /** `quotas` and `distributeNow` are for tests (app.ts); production reads the limits from the environment. */
  static forRoot(quotas?: QuotaOptions, distributeNow?: () => Date): DynamicModule {
    return {
      module: CommonModule,
      global: true,
      imports: [AuthModule],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: RedInterceptor },
        { provide: APP_FILTER, useClass: FinalStatusFilter },
        { provide: APP_GUARD, useClass: DenyByDefaultGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: TeamMemberGuard },
        { provide: QuotaLimiter, useFactory: (db: Database) => quotaLimiter(db, quotas, undefined, undefined, distributeNow), inject: [Database] },
        QuotaGuard,
      ],
      exports: [QuotaLimiter, QuotaGuard],
    };
  }
}
