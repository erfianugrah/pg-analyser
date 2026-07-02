import { SQL } from "bun";
import type { Management } from "./management.ts";
import type { SqlRow } from "./schemas.ts";

/**
 * A SQL execution backend for the diagnostic query set. Two tiers:
 *
 *  - ManagementSqlRunner: PAT-only, via the Management API read-only SQL runner
 *    (runs as `supabase_read_only_user`). The default - no password needed, so
 *    it can audit a customer project you only have a PAT for.
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
  close(): Promise<void> {
    return this.#sql.end();
  }
}
