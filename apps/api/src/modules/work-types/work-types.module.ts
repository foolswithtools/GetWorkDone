import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module.js';
import { WorkTypesController } from './work-types.controller.js';
import { WorkTypesService } from './work-types.service.js';

@Module({ imports: [TeamsModule], controllers: [WorkTypesController], providers: [WorkTypesService], exports: [WorkTypesService] })
export class WorkTypesModule {}
