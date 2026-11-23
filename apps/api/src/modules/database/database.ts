// The one Prisma client the API's services share (@getworkdone/db). It connects on the first query, so
// the app starts, and /healthz answers, without a database; it disconnects when the app closes.
// Database calls are not outbound HTTP, so scripts/instrument-lint.ts does not ask for withSpan here;
// the Secrets Manager read below is, and runs inside one.
//
// #66: in the sandbox, ECS injects the database secret as DATABASE_CREDENTIALS when the task starts:
// since #57 getworkdone/<instance>/db-app, the getworkdone_app role's, which does not rotate (it was
// RDS's rotating master secret before). The app stage also passes the secret's ARN as
// DATABASE_CREDENTIALS_SECRET_ARN, so when Postgres refuses the password the task started with (the
// owner put a new one), the pool re-reads the secret (packages/db/src/credentials.ts) through the task
// role's one GetSecretValue grant on that ARN. The URL verifies the server against the RDS CA bundle
// at DATABASE_SSL_ROOT_CERT (packages/db/src/database-url.ts).

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, databaseUrl, type CredentialRereadOptions, type PrismaClient } from '@getworkdone/db';
import { withSpan } from '@getworkdone/telemetry';
import { apiLogger } from '../../common/logger.js';

/** The part of SecretsManagerClient the re-read uses, so a test can stub it. */
export interface SecretsClientLike {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

/** The pool's re-read of the database secret, or undefined without DATABASE_CREDENTIALS_SECRET_ARN (local runs, CI). */
export function credentialReread(
  env: NodeJS.ProcessEnv,
  secretsClient: () => SecretsClientLike = () => new SecretsManagerClient({}),
): CredentialRereadOptions | undefined {
  const arn = env.DATABASE_CREDENTIALS_SECRET_ARN;
  if (!arn) return undefined;
  let client: SecretsClientLike | undefined;
  return {
    readSecret: () =>
      withSpan('database.credentials.reread', async () => {
        client ??= secretsClient();
        const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: arn }));
        if (!SecretString) throw new Error('The database secret has no SecretString');
        return SecretString;
      }),
    onReread: ({ changed }) =>
      apiLogger.warn({ changed }, changed ? 'database password refused; re-read the changed database secret' : 'database password refused; the re-read database secret is unchanged'),
  };
}

@Injectable()
export class Database implements OnModuleDestroy {
  readonly client: PrismaClient = createPrismaClient(databaseUrl(process.env), credentialReread(process.env));

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
