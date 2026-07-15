import { describe, expect, test } from "bun:test";
import type { Management } from "../src/management.ts";
import type { SqlRow } from "../src/schemas.ts";
import {
  DirectSqlRunner,
  ManagementSqlRunner,
  normalizeMultiResult,
  type SqlLike,
} from "../src/sqlrunner.ts";

/** A recording fake for the Bun.SQL slice DirectSqlRunner needs. */
function fakeSql(result: unknown): SqlLike & { queries: string[]; ended: number } {
  const queries: string[] = [];
  let ended = 0;
  return {
    queries,
    get ended() {
      return ended;
    },
    async unsafe(query: string) {
      queries.push(query);
      return result;
    },
    async end() {
      ended++;
    },
  };
}

describe("ManagementSqlRunner", () => {
  test("source is read-only and run() delegates to Management.readOnlySql(ref, query)", async () => {
    const calls: Array<[string, string]> = [];
    const rows: SqlRow[] = [{ a: 1 }];
    const fake = {
      readOnlySql: async (ref: string, query: string) => {
        calls.push([ref, query]);
        return rows;
      },
    } as unknown as Management;
    const r = new ManagementSqlRunner(fake, "myref");
    expect(r.source).toBe("read-only");
    const out = await r.run("select 1");
    expect(out).toBe(rows);
    expect(calls).toEqual([["myref", "select 1"]]);
  });
});

describe("DirectSqlRunner", () => {
  test("source is superuser; run() prepends the session guard and returns the query's rows", async () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const sql = fakeSql(rows);
    const r = new DirectSqlRunner("postgres://ignored", sql);
    expect(r.source).toBe("superuser");
    const out = await r.run("select * from t");
    expect(out).toEqual(rows as unknown as SqlRow[]);
    // every superuser query is bounded: statement_timeout + lock_timeout are sent
    // in the SAME message so they bind to the same backend, then the query.
    expect(sql.queries[0]).toContain("set statement_timeout=");
    expect(sql.queries[0]).toContain("set lock_timeout=");
    expect(sql.queries[0]).toContain("select * from t");
  });

  test("run() returns the LAST result set (the query's), ignoring the guard's SET sets", async () => {
    // Simulate a real backend: two empty SET results, then the query rows.
    const sql = fakeSql([[], [], [{ a: 9 }]]);
    const r = new DirectSqlRunner("postgres://ignored", sql);
    expect(await r.run("select 9")).toEqual([{ a: 9 }] as unknown as SqlRow[]);
  });

  test("SBPERF_STATEMENT_TIMEOUT overrides the default bound", async () => {
    const prev = process.env.SBPERF_STATEMENT_TIMEOUT;
    process.env.SBPERF_STATEMENT_TIMEOUT = "5min";
    try {
      const sql = fakeSql([]);
      const r = new DirectSqlRunner("postgres://ignored", sql);
      await r.run("select 1");
      expect(sql.queries[0]).toContain("statement_timeout='5min'");
    } finally {
      if (prev === undefined) delete process.env.SBPERF_STATEMENT_TIMEOUT;
      else process.env.SBPERF_STATEMENT_TIMEOUT = prev;
    }
  });

  test("runMulti() normalizes a single-statement flat array to one result set", async () => {
    const sql = fakeSql([{ a: 1 }, { a: 2 }]);
    const r = new DirectSqlRunner("postgres://ignored", sql);
    expect(await r.runMulti("select 1")).toEqual([[{ a: 1 }, { a: 2 }]]);
  });

  test("runMulti() passes an array-of-arrays (multi-statement) through", async () => {
    const sql = fakeSql([[{ a: 1 }], [{ b: 2 }]]);
    const r = new DirectSqlRunner("postgres://ignored", sql);
    expect(await r.runMulti("select 1; select 2")).toEqual([[{ a: 1 }], [{ b: 2 }]]);
  });

  test("close() ends the underlying connection pool", async () => {
    const sql = fakeSql([]);
    const r = new DirectSqlRunner("postgres://ignored", sql);
    await r.close();
    expect(sql.ended).toBe(1);
  });
});

describe("normalizeMultiResult", () => {
  test("array-of-arrays (multi-statement) passes through", () => {
    const res = [[{ a: 1 }], [{ b: 2 }]];
    expect(normalizeMultiResult(res)).toEqual(res as unknown as SqlRow[][]);
  });
  test("flat row array (single statement) is wrapped as one result set", () => {
    expect(normalizeMultiResult([{ a: 1 }, { a: 2 }])).toEqual([[{ a: 1 }, { a: 2 }]]);
  });
  test("empty result -> a single empty set", () => {
    expect(normalizeMultiResult([])).toEqual([[]]);
  });
});
