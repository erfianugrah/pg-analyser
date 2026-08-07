// Acceptance - plan Task 1: freeze-age query correctness.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { QUERIES } from "../src/sql.ts";
import { analysis } from "./fixture.ts";

describe("Task 1 - per-relation freeze age includes TOAST and reports remaining", () => {
  test("txidWraparound joins the TOAST relation and ranks on the greater age", () => {
    const q = QUERIES.txidWraparound.toLowerCase();
    expect(q).toContain("reltoastrelid");
    expect(q).toContain("greatest(");
    expect(q).toContain("relfrozenxid");
  });

  test("txidWraparound exposes a remaining-transactions column", () => {
    expect(QUERIES.txidWraparound.toLowerCase()).toContain("remaining");
  });

  test("multixactWraparound gets the same TOAST treatment and a remaining column", () => {
    const q = QUERIES.multixactWraparound.toLowerCase();
    expect(q).toContain("reltoastrelid");
    expect(q).toContain("greatest(");
    expect(q).toContain("remaining");
  });
});

describe("Task 1 - database-level freeze age (includes catalogs)", () => {
  test("databaseFreezeAge reads pg_database.datfrozenxid", () => {
    const q = (QUERIES as Record<string, string>).databaseFreezeAge;
    expect(q).toBeDefined();
    const lower = String(q).toLowerCase();
    expect(lower).toContain("pg_database");
    expect(lower).toContain("datfrozenxid");
  });

  test("the analysis schema carries a defaulted databaseFreezeAge plane", () => {
    const a = analysis((raw) => {
      raw.sql.databaseFreezeAge = [{ datname: "postgres", xid_age: 1, remaining: 2 }];
    });
    const rows = (a.sql as Record<string, unknown>).databaseFreezeAge as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });
});
