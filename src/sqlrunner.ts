import { SQL } from "bun";
import type { Management } from "./management.ts";
import type { SqlRow } from "./schemas.ts";

/**
 * A SQL execution backend for the diagnostic query set. Two tiers:
 *
 *  - ManagementSqlRunner: PAT-only, via the Management API read-only SQL runner
 *    (runs as `supabase_read_only_user`). The default - no password needed, so
 *    it can audit a project you only have a PAT for.
 *  - DirectSqlRunner: a superuser/`--db-url` connection (e.g. Supabase's
 *    `supabase_admin` connstring, or ANY Postgres). Full access - real inspect,
 *    all schemas, arbitrary/multiple databases, and the ability to window
 *    pg_stat_statements. Opt-in for your own projects or a shared admin creds.
 *
 * `source` is surfaced in the report so a reader knows which tier produced the
 * SQL evidence. The connstring itself is NEVER stored in the Analysis.
 */
export interface SqlRunner {
  readonly source: "read-only" | "superuser";
  run(query: string): Promise<SqlRow[]>;
  /**
   * Run a multi-statement query and return each statement's result set. Only
   * the superuser DirectSqlRunner implements this (simple-query protocol);
   * absent on the PAT read-only tier. Used to self-host the splinter advisor.
   */
  runMulti?(query: string): Promise<SqlRow[][]>;
}

/**
 * Normalize a Bun.SQL simple-query result to SqlRow[][]: a multi-statement
 * command returns an array of result sets (each an array), while a single
 * statement returns a flat row array - wrap the latter as one result set.
 */
export function normalizeMultiResult(res: unknown[]): SqlRow[][] {
  return Array.isArray(res[0]) ? (res as SqlRow[][]) : [res as SqlRow[]];
}

/** PAT path: delegates to the Management API read-only SQL endpoint. */
export class ManagementSqlRunner implements SqlRunner {
  readonly source = "read-only" as const;
  constructor(
    private readonly m: Management,
    private readonly ref: string,
  ) {}
  run(query: string): Promise<SqlRow[]> {
    return this.m.readOnlySql(this.ref, query);
  }
}

/**
 * Superuser path: runs each diagnostic query directly over a Postgres
 * connection string. `prepare: false` + `max: 2` keeps it safe behind a
 * transaction-mode pooler (Supabase's 6543 pooler rejects prepared statements).
 * Close with `close()` when done so the process can exit.
 */
export class DirectSqlRunner implements SqlRunner {
  readonly source = "superuser" as const;
  #sql: SQL;
  constructor(dbUrl: string) {
    this.#sql = new SQL(dbUrl, { prepare: false, max: 2 });
  }
  async run(query: string): Promise<SqlRow[]> {
    const rows = await this.#sql.unsafe(query);
    return rows as unknown as SqlRow[];
  }

  /**
   * Bun.SQL with prepare:false uses the simple-query protocol, which allows
   * multiple statements in one command and returns one result set per
   * statement. A single-statement query returns a flat row array, so normalize
   * to SqlRow[][].
   */
  async runMulti(query: string): Promise<SqlRow[][]> {
    return normalizeMultiResult((await this.#sql.unsafe(query)) as unknown[]);
  }
  close(): Promise<void> {
    return this.#sql.end();
  }
}
