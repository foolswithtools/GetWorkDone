// Database credentials that survive an RDS rotation (#66, approach A). RDS rotates the master secret
// (deploy/sandbox/data/rds.tf, manage_master_user_password), but ECS resolves DATABASE_CREDENTIALS only
// when the task starts, so a task that outlives a rotation holds the old password: its open
// connections keep working and every new one fails with SQLSTATE 28P01. This pool gives each new
// connection the password it holds (node-postgres calls a `password` function per connection) and, when
// Postgres refuses it with 28P01, re-reads the secret once and connects again. The read itself is the
// caller's (the API reads Secrets Manager inside a span), so this package makes no outbound call.
import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';
import { databaseCredentials } from './database-url.js';

export interface CredentialRereadOptions {
  /** Reads the master secret again: its JSON, {"username": ..., "password": ...}, as Secrets Manager returns it. */
  readSecret: () => Promise<string>;
  /** Told after each re-read whether the password changed, for the caller's log. */
  onReread?: (event: { changed: boolean }) => void;
}

const AUTHENTICATION_FAILED = '28P01';

type ConnectCallback = (error: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void;

/** A pg pool whose connections re-read the master secret once when Postgres refuses the password. */
export class RereadingPool extends pg.Pool {
  #password: string;
  #reading: Promise<void> | undefined;
  readonly #reread: CredentialRereadOptions;

  constructor(config: pg.PoolConfig & { password: string }, reread: CredentialRereadOptions) {
    // pg-connection-string's parse sets password to '' when a URL has none, so the function goes last.
    super({ ...config, password: () => this.#password });
    this.#password = config.password;
    this.#reread = reread;
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  // pg-pool's own query() takes its client through the callback form; PrismaPg's transactions use the promise.
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const connected = this.#connect();
    if (!callback) return connected;
    connected.then(
      (client) => process.nextTick(callback, undefined, client, client.release),
      (error: Error) => process.nextTick(callback, error, undefined, () => undefined),
    );
  }

  async #connect(): Promise<pg.PoolClient> {
    const tried = this.#password;
    try {
      return await super.connect();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== AUTHENTICATION_FAILED) throw error;
      // Connections refused together re-read once: only the first to fail with the held password reads.
      if (this.#password === tried) await this.#rereadSecret();
      return super.connect();
    }
  }

  #rereadSecret(): Promise<void> {
    this.#reading ??= (async () => {
      try {
        // Deferred, so a readSecret that throws synchronously still clears #reading after it is set.
        await Promise.resolve();
        const { password } = databaseCredentials(await this.#reread.readSecret());
        const changed = password !== this.#password;
        this.#password = password;
        this.#reread.onReread?.({ changed });
      } finally {
        this.#reading = undefined;
      }
    })();
    return this.#reading;
  }
}

/** The pool for a database URL (database-url.ts), parsed so its TLS parameters hold and its password starts the pool. */
export function rereadingPool(url: string, reread: CredentialRereadOptions): RereadingPool {
  const config = parseIntoClientConfig(url);
  return new RereadingPool({ ...config, password: typeof config.password === 'string' ? config.password : '' }, reread);
}
