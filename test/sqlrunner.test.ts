import { describe, expect, test } from "bun:test";
import type { Management } from "../src/management.ts";
import type { SqlRow } from "../src/schemas.ts";
import { ManagementSqlRunner, normalizeMultiResult } from "../src/sqlrunner.ts";

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
