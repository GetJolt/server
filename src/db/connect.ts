import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { migrationProvider } from './migrations.js';
import type { Database } from './schema.js';

export type Dialect = 'sqlite' | 'postgres';

export interface DatabaseHandle {
  db: Kysely<Database>;
  dialect: Dialect;
}

export function connectDatabase(url: string): DatabaseHandle {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), dialect: 'postgres' };
  }

  if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true });
  const sqlite = new SQLite(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // Snowflakes don't fit in a JS number, so integers come back as bigint and are converted in db/values.ts.
  sqlite.defaultSafeIntegers(true);
  return {
    db: new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) }),
    dialect: 'sqlite',
  };
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === 'Error') throw new Error(`Migration ${result.migrationName} failed`);
  }
  if (error) throw error;
}
