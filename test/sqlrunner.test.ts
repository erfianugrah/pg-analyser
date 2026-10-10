import { describe, expect, test } from "bun:test";
import type { Management } from "../src/management.ts";
import type { SqlRow } from "../src/schemas.ts";
import {
  DirectSqlRunner,
  ManagementSqlRunner,
  normalizeMultiResult,
  type SqlLike,
  sessionGuard,
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

  test("PG_ANALYSER_STATEMENT_TIMEOUT overrides the default bound", async () => {
    const prev = process.env.PG_ANALYSER_STATEMENT_TIMEOUT;
    process.env.PG_ANALYSER_STATEMENT_TIMEOUT = "5min";
    try {
      const sql = fakeSql([]);
      const r = new DirectSqlRunner("postgres://ignored", sql);
      await r.run("select 1");
      expect(sql.queries[0]).toContain("statement_timeout='5min'");
    } finally {
      if (prev === undefined) delete process.env.PG_ANALYSER_STATEMENT_TIMEOUT;
      else process.env.PG_ANALYSER_STATEMENT_TIMEOUT = prev;
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

describe("session prelude application_name", () => {
  const KEY = "PG_ANALYSER_APPLICATION_NAME";
  const withEnv = (v: string | undefined, fn: () => void) => {
    const prev = process.env[KEY];
    if (v === undefined) delete process.env[KEY];
    else process.env[KEY] = v;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  };

  test("the prelude names the session pg-analyser so its log lines can be told apart", () => {
    withEnv(undefined, () => {
      expect(sessionGuard()).toContain("set application_name='pg-analyser'; ");
    });
  });

  test("PG_ANALYSER_APPLICATION_NAME overrides it and is sanitised like the other values", () => {
    withEnv("audit-nightly", () => {
      expect(sessionGuard()).toContain("set application_name='audit-nightly'; ");
    });
    withEnv("x'; drop table t; --", () => {
      const g = sessionGuard();
      expect(g).not.toContain("drop table t;");
      expect(g).toContain("set application_name='x drop table t --'; "); // quote and ; stripped; text stays inside the literal
      expect(g.match(/'/g)?.length).toBe(6); // three quoted SETs, nothing injected
    });
    withEnv("   ", () => {
      expect(sessionGuard()).toContain("set application_name='pg-analyser'; ");
    });
  });

  test("DirectSqlRunner sends the application_name SET in the same message as the query", async () => {
    const sql = fakeSql([]);
    await new DirectSqlRunner("postgres://ignored", sql).run("select 1");
    expect(sql.queries[0]).toMatch(/set application_name='[^']+'; .*select 1$/);
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
