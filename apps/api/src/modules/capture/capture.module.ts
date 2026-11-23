import { Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { ProcessModule } from '../process/process.module.js';
import { WorkTypesModule } from '../work-types/work-types.module.js';
import { CaptureController } from './capture.controller.js';
import { CaptureService } from './capture.service.js';
import { MatcherCache } from './matcher-cache.js';

@Module({ imports: [WorkTypesModule, ItemsModule, ProcessModule], controllers: [CaptureController], providers: [CaptureService, { provide: MatcherCache, useFactory: () => new MatcherCache() }] })
export class CaptureModule {}
