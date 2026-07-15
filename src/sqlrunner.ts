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
 * The slice of Bun.SQL that DirectSqlRunner actually uses. Declaring it lets a
 * test inject a fake backend (the real one opens a network connection in its
 * constructor). `unsafe` runs a raw query string; `end` closes the pool.
 */
export interface SqlLike {
  unsafe(query: string): Promise<unknown>;
  end(): Promise<void>;
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
/**
 * Session guards prepended to EVERY superuser query so no diagnostic can run
 * unbounded against a live customer database. statement_timeout caps runtime;
 * lock_timeout caps time spent blocked on a lock (sbperf is read-only, so it
 * only ever takes AccessShareLock, but this fails fast rather than queueing
 * behind someone's ALTER). Both overridable via env; '0' disables a cap
 * (Postgres semantics). Sent in the SAME simple-query message as the query so
 * they bind to the same pooled backend (a plain prior `SET` would not, in a
 * transaction pooler). The guard's SET results are empty sets: run() takes the
 * LAST result set (the query's) and splinter picks the LARGEST, so the leading
 * empties are ignored by both.
 */
export function sessionGuard(): string {
  const clean = (v: string) => v.replace(/[^0-9a-z ]/gi, "").trim() || "0";
  const st = clean(process.env.SBPERF_STATEMENT_TIMEOUT ?? "120s");
  const lt = clean(process.env.SBPERF_LOCK_TIMEOUT ?? "15s");
  return `set statement_timeout='${st}'; set lock_timeout='${lt}'; `;
}

export class DirectSqlRunner implements SqlRunner {
  readonly source = "superuser" as const;
  #sql: SqlLike;
  #guard: string;
  /**
   * `dbUrl` opens a pooler-safe connection (prepare:false + max:2). Tests may
   * pass a fake `sql` backend to exercise run/runMulti/close without a network.
   */
  constructor(dbUrl: string, sql?: SqlLike) {
    this.#sql = sql ?? new SQL(dbUrl, { prepare: false, max: 2 });
    this.#guard = sessionGuard();
  }
  async run(query: string): Promise<SqlRow[]> {
    // Guard + query in one message; the query's rows are the LAST result set.
    const sets = normalizeMultiResult((await this.#sql.unsafe(this.#guard + query)) as unknown[]);
    return (sets[sets.length - 1] ?? []) as SqlRow[];
  }

  /**
   * Bun.SQL with prepare:false uses the simple-query protocol, which allows
   * multiple statements in one command and returns one result set per
   * statement. A single-statement query returns a flat row array, so normalize
   * to SqlRow[][]. The guard's two empty SET sets lead; callers that scan the
   * sets (splinter picks the largest) ignore them.
   */
  async runMulti(query: string): Promise<SqlRow[][]> {
    return normalizeMultiResult((await this.#sql.unsafe(this.#guard + query)) as unknown[]);
  }
  close(): Promise<void> {
    return this.#sql.end();
  }
}
