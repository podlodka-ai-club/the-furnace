import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "./migrate.js";

export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  migrate(): Promise<{ applied: string[] }>;
  close(): Promise<void>;
}

export interface CreateDatabaseConfig {
  dataDir?: string;
}

interface QueryRunner {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

function wrap(runner: QueryRunner, pg: PGlite, isTx: boolean): Database {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await runner.query<T>(sql, params as unknown[] | undefined);
      return result.rows;
    },
    async exec(sql: string): Promise<void> {
      await runner.exec(sql);
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      if (isTx) {
        return fn(wrap(runner, pg, true));
      }
      return pg.transaction(async (tx) => fn(wrap(tx, pg, true)));
    },
    async migrate(): Promise<{ applied: string[] }> {
      const migrationsDir = new URL("./migrations/", import.meta.url);
      return runMigrations(pg, migrationsDir);
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

export async function createDatabase(config: CreateDatabaseConfig = {}): Promise<Database> {
  const pg = config.dataDir !== undefined ? new PGlite(config.dataDir) : new PGlite();
  await pg.waitReady;
  return wrap(pg, pg, false);
}
