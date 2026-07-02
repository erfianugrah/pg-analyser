import { describe, expect, test } from "bun:test";
import { QUERIES } from "../src/sql.ts";

const WRITE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i;

describe("perf query set is read-only", () => {
  for (const [name, sql] of Object.entries(QUERIES)) {
    test(`${name} is a read-only SELECT/CTE with no write keywords`, () => {
      const head = sql.trim().toLowerCase();
      expect(head.startsWith("select") || head.startsWith("with")).toBe(true);
      expect(sql).not.toMatch(WRITE);
    });
  }

  test("covers the monitor- best-practice diagnostics", () => {
    const keys = Object.keys(QUERIES);
    for (const k of ["topStatements", "unusedIndexes", "seqScanHeavy", "deadTuples", "cacheHit"]) {
      expect(keys).toContain(k);
    }
  });
});
