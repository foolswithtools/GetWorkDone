import { Module } from '@nestjs/common';
import { Database } from '../database/database.js';
import { HealthController } from './health.controller.js';
import { Readiness, readinessOptionsFromEnv } from './readiness.js';

@Module({
  controllers: [HealthController],
  providers: [{ provide: Readiness, useFactory: (db: Database) => new Readiness(db, readinessOptionsFromEnv()), inject: [Database] }],
})
export class HealthModule {}
