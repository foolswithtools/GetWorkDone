// The API's database role (#57): packages/db/sql/app-role.sql, which the migrate task runs after the
// migrations with the password from getworkdone/<instance>/db-app (migrate-task.ts).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { databaseCredentials } from './database-url.js';

/** The role app-role.sql creates; the db-app secret's username must be this. */
export const APP_ROLE_NAME = 'getworkdone_app';

/** The SQL file, beside src/ and dist/ alike (package.json "files" ships sql/). */
export const APP_ROLE_SQL = fileURLToPath(new URL('../sql/app-role.sql', import.meta.url));

const PASSWORD_VARIABLE = ":'password'";

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802, RFC 7677; Postgres's
 * scram_build_secret): SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, base64. Postgres
 * stores a verifier given as the password as it is, so the plaintext never reaches the server. The
 * password must be printable ASCII, which SASLprep leaves unchanged.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * app-role.sql with its one psql variable replaced by the password's SCRAM-SHA-256 verifier as a string
 * literal (base64 and $ only, so no quoting is needed), so neither pg_stat_activity, a statement log nor
 * an error's CONTEXT line can show the password. Throws, never quoting the password, unless the variable
 * appears exactly once and the password is non-empty printable ASCII.
 */
export function renderAppRoleSql(sql: string, password: string): string {
  if (sql.split(PASSWORD_VARIABLE).length !== 2) throw new Error(`app-role.sql must hold exactly one ${PASSWORD_VARIABLE}`);
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('the app role password must be non-empty printable ASCII');
  return sql.replace(PASSWORD_VARIABLE, () => `'${scramSha256Verifier(password)}'`);
}

/** DATABASE_APP_CREDENTIALS, the db-app secret's JSON, as its username (getworkdone_app) and password. */
export function appRoleCredentials(env: NodeJS.ProcessEnv): { username: string; password: string } {
  const credentials = databaseCredentials(env.DATABASE_APP_CREDENTIALS ?? '', 'DATABASE_APP_CREDENTIALS');
  if (credentials.username !== APP_ROLE_NAME) throw new Error(`DATABASE_APP_CREDENTIALS's username must be ${APP_ROLE_NAME}, the role app-role.sql creates`);
  return credentials;
}
