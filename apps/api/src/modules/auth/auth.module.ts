import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { Database } from '../database/database.js';
import { schemaReady } from '../database/schema-ready.js';
import { LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS, PostgresLoginRateStore, RateLimiter, loginRateLimitFromEnv } from './login-rate-limit.js';
import { MeController } from './me.controller.js';
import { SESSION_PURGE_TABLE, SessionPurge, sessionPurgeOptionsFromEnv } from './session-purge.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [
    SessionsService,
    {
      provide: SessionPurge,
      useFactory: (sessions: SessionsService, db: Database) => new SessionPurge(sessions, { ...sessionPurgeOptionsFromEnv(), tableReady: () => schemaReady(db, SESSION_PURGE_TABLE) }),
      inject: [SessionsService, Database],
    },
    {
      provide: LOGIN_RATE_LIMIT,
      useFactory: (db: Database) => new RateLimiter({ store: new PostgresLoginRateStore(db), limit: loginRateLimitFromEnv(), windowMs: LOGIN_RATE_WINDOW_MS }),
      inject: [Database],
    },
  ],
  exports: [SessionsService],
})
export class AuthModule {}
