import { describe, expect, test } from "bun:test";
import { collectSplinterPerfLints, parseSplinterPerfLints } from "../src/splinter.ts";
import type { SqlRunner } from "../src/sqlrunner.ts";

// Splinter-shaped rows (the columns the lint SQL selects).
const perfLint = (name: string) => ({
  name,
  title: "Unused Index",
  level: "INFO",
  facing: "EXTERNAL",
  categories: ["PERFORMANCE"],
  description: "d",
  detail: "Index `x` is unused",
  remediation: "https://supabase.com/docs/guides/database/database-linter?lint=0005",
});
const secLint = (name: string) => ({ ...perfLint(name), categories: ["SECURITY"] });

describe("parseSplinterPerfLints", () => {
  test("keeps only PERFORMANCE lints and validates the Advisor shape", () => {
    const out = parseSplinterPerfLints([
      perfLint("unused_index"),
      secLint("auth_users_exposed"),
      perfLint("unindexed_foreign_keys"),
    ]);
    expect(out.map((l) => l.name)).toEqual(["unused_index", "unindexed_foreign_keys"]);
    expect(out[0]?.remediation).toContain("database-linter");
  });

  test("drops lints missing the PERFORMANCE category", () => {
    expect(
      parseSplinterPerfLints([secLint("a"), { ...perfLint("b"), categories: [] }]),
    ).toHaveLength(0);
  });

  test("throws on a shape it doesn't recognise (fail loud, not silent)", () => {
    expect(() => parseSplinterPerfLints([{ nope: 1 }])).toThrow();
  });
});

describe("collectSplinterPerfLints", () => {
  const withMulti = (sets: unknown[][]): SqlRunner => ({
    source: "superuser",
    run: async () => [],
    runMulti: async () => sets as never,
  });

  test("extracts the largest result set (the lint SELECT) and filters PERFORMANCE", async () => {
    // set local -> [], do-block -> [], lint SELECT -> the rows
    const runner = withMulti([
      [],
      [],
      [perfLint("unused_index"), secLint("x"), perfLint("no_primary_key")],
    ]);
    const out = await collectSplinterPerfLints(runner);
    expect(out.map((l) => l.name)).toEqual(["unused_index", "no_primary_key"]);
  });

  test("returns [] on a runner without multi-statement support (PAT tier)", async () => {
    const patRunner: SqlRunner = { source: "read-only", run: async () => [] };
    expect(await collectSplinterPerfLints(patRunner)).toEqual([]);
  });
});
