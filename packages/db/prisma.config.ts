import type { PrismaConfig } from 'prisma';
import { databaseUrlFromEnv } from './src/database-url.js';

// Prisma owns the schema and its migrations. The URL is DATABASE_URL, or the sandbox's parts with the
// CLI's TLS parameters (src/database-url.ts, #8). The CLI loads this file as source, also inside the
// image, where it runs `prisma migrate deploy` as the one-off migrate task (docs/deploy/sandbox.md); so
// it imports the one source file the package ships besides dist/ (package.json "files"), and only types
// from prisma, so nothing here depends on which packages resolve from the image's copy of the package.
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: databaseUrlFromEnv(process.env, { consumer: 'prisma' }) },
} satisfies PrismaConfig;
