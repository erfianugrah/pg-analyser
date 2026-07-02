import { describe, expect, test } from "bun:test";
import { type Baseline, classifyDrift, sha256 } from "../scripts/check-inspect-drift.ts";

const manifest = [
  { dir: "bloat", derives: "bloat", note: "tables-only + waste_bytes" },
  { dir: "outliers", derives: "topStatements" },
] as const;

describe("classifyDrift", () => {
  test("no drift when current hashes match the baseline", () => {
    const baseline: Baseline = {
      bloat: { sha256: "aaa", reviewed: "2026-07-02" },
      outliers: { sha256: "bbb", reviewed: "2026-07-02" },
    };
    const current = new Map([
      ["bloat", "aaa"],
      ["outliers", "bbb"],
    ]);
    const { drifted, missing } = classifyDrift(manifest, baseline, current);
    expect(drifted).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("flags a query whose upstream hash changed, naming the derived key", () => {
    const baseline: Baseline = {
      bloat: { sha256: "aaa", reviewed: "2026-07-02" },
      outliers: { sha256: "bbb", reviewed: "2026-07-02" },
    };
    const current = new Map([
      ["bloat", "CHANGED"],
      ["outliers", "bbb"],
    ]);
    const { drifted } = classifyDrift(manifest, baseline, current);
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toContain("bloat.sql changed upstream");
    expect(drifted[0]).toContain("src/sql.ts:bloat");
    expect(drifted[0]).toContain("tables-only + waste_bytes");
  });

  test("reports a query with no baseline as missing, not drifted", () => {
    const baseline: Baseline = { bloat: { sha256: "aaa", reviewed: "2026-07-02" } };
    const current = new Map([
      ["bloat", "aaa"],
      ["outliers", "bbb"],
    ]);
    const { drifted, missing } = classifyDrift(manifest, baseline, current);
    expect(drifted).toEqual([]);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("outliers");
  });

  test("an unfetchable query (absent from current) is neither drifted nor missing", () => {
    const baseline: Baseline = {
      bloat: { sha256: "aaa", reviewed: "2026-07-02" },
      outliers: { sha256: "bbb", reviewed: "2026-07-02" },
    };
    const current = new Map([["bloat", "aaa"]]); // outliers fetch failed
    const { drifted, missing } = classifyDrift(manifest, baseline, current);
    expect(drifted).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("sha256 is stable and content-sensitive", () => {
    expect(sha256("SELECT 1")).toBe(sha256("SELECT 1"));
    expect(sha256("SELECT 1")).not.toBe(sha256("SELECT 2"));
  });
});
