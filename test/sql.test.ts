import { describe, expect, test } from "bun:test";
import { QUERIES } from "../src/sql.ts";

const WRITE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i;

describe("perf query set is read-only", () => {
  for (const [name, sql] of Object.entries(QUERIES)) {
    test(`${name} is a bare SELECT with no write keywords`, () => {
      expect(sql.trim().toLowerCase().startsWith("select")).toBe(true);
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
