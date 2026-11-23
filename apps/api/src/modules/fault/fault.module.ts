// The fault injection module (GWP#9): the drill and fault routes. AppModule imports it only when
// FAULT_INJECTION_ENABLED=true, so without the flag neither route exists: a POST to /api/v1/__fault is
// 404 before any guard, and a GET of /api/v1/__drill reaches the SPA route (401, or 404 signed in).

import { Module, type DynamicModule } from '@nestjs/common';
import { subjectsFromEnv } from '../../common/subjects.js';
import { FaultAdminGuard } from './fault-admin.guard.js';
import { FaultController } from './fault.controller.js';
import { FAULT_OPTIONS, FaultState, type FaultOptions } from './fault.state.js';

/** The fault settings from the environment; a value other than true or false, or a bad subject list, throws. */
export function faultOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FaultOptions {
  const flag = env.FAULT_INJECTION_ENABLED ?? '';
  if (!['', 'true', 'false'].includes(flag)) throw new Error(`FAULT_INJECTION_ENABLED must be true or false, not ${JSON.stringify(flag)}`);
  return { enabled: flag === 'true', adminSubjects: subjectsFromEnv('FAULT_ADMIN_SUBJECTS', env) };
}

@Module({})
export class FaultModule {
  static forRoot(options: FaultOptions): DynamicModule {
    return {
      module: FaultModule,
      controllers: [FaultController],
      providers: [{ provide: FAULT_OPTIONS, useValue: options }, FaultState, FaultAdminGuard],
    };
  }
}
