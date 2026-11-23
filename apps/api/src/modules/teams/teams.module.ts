import { Module } from '@nestjs/common';
import { MembersController } from './members.controller.js';
import { TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';

@Module({ controllers: [TeamsController, MembersController], providers: [TeamsService], exports: [TeamsService] })
export class TeamsModule {}
