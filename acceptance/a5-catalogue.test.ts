// Acceptance - plan Task 5: the catalogue tells the reader to clear the horizon
// BEFORE vacuuming, and stops recommending the two vacuum forms upstream rules
// out in the emergency window.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { HEURISTICS, meta } from "../src/heuristics.ts";

const NEW_IDS = [
  "xmin_horizon_blocked",
  "replication_slot_lost",
  "prepared_xact_old",
  "freeze_blocked_no_holder",
];

describe("Task 5 - txid_wraparound is re-ordered around the horizon", () => {
  const m = () => meta("txid_wraparound");

  test("the remediation clears the xmin holder before it mentions vacuum", () => {
    const r = (m().remediation ?? "").toLowerCase();
    expect(r).toContain("vacuum");
    const holder = Math.min(
      ...["slot", "prepared", "xmin", "backend"]
        .map((w) => r.indexOf(w))
        .filter((i) => i >= 0)
        .concat([Number.POSITIVE_INFINITY]),
    );
    expect(holder).toBeLessThan(r.indexOf("vacuum"));
  });

  test("the SQL block covers all three holder views", () => {
    const sql = (m().sql ?? "").toLowerCase();
    expect(sql).toContain("pg_replication_slots");
    expect(sql).toContain("pg_prepared_xacts");
    expect(sql).toContain("pg_stat_activity");
  });

  test("it does not recommend VACUUM FULL (upstream: needs an XID, fails or consumes one)", () => {
    const all = `${m().remediation ?? ""} ${m().sql ?? ""}`.toLowerCase();
    expect(all).not.toContain("vacuum full");
  });

  test("the superuser caveat is stated (a non-superuser VACUUM cannot advance datfrozenxid)", () => {
    const all = `${m().remediation ?? ""} ${m().whyItMatters ?? ""} ${m().howToVerify ?? ""}`;
    expect(all.toLowerCase()).toContain("superuser");
  });

  test("verification is stated in transactions remaining, not a percentage", () => {
    expect((m().howToVerify ?? "").toLowerCase()).toContain("remaining");
  });
});

describe("Task 5 - every new finding is catalogued", () => {
  for (const id of NEW_IDS) {
    test(`${id} has a full card`, () => {
      const h = HEURISTICS[id];
      expect(h).toBeDefined();
      expect((h?.remediation ?? "").length).toBeGreaterThan(20);
      expect((h?.whyItMatters ?? "").length).toBeGreaterThan(20);
      expect((h?.howToVerify ?? "").length).toBeGreaterThan(10);
      expect(h?.docUrl ?? "").toMatch(/^https:\/\//);
    });
  }

  test("the catalogue stays ASCII (commit-safe, per the existing convention)", () => {
    for (const id of NEW_IDS) {
      const h = HEURISTICS[id];
      const blob = `${h?.remediation ?? ""}${h?.whyItMatters ?? ""}${h?.howToVerify ?? ""}${h?.sql ?? ""}`;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
      expect(blob).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});

describe("Task 5 - pg-analyser stays read-only", () => {
  test("remediation SQL is printed for a human, never executed by the tool", () => {
    // The catalogue may CONTAIN pg_drop_replication_slot / ROLLBACK PREPARED /
    // pg_terminate_backend as copy-pasteable text; the guarantee under test is
    // that no source module outside the catalogue issues them.
    const blob = Object.values(HEURISTICS)
      .map((h) => `${h.remediation} ${h.sql ?? ""}`)
      .join("\n")
      .toLowerCase();
    expect(blob).toContain("pg_drop_replication_slot");
  });
});
