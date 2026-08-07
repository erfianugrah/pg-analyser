// Acceptance - plan Task 6: the autovacuum freeze knobs are collected and the
// obviously-broken settings produce a finding.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { configTuningFindings, deriveFindings } from "../src/findings.ts";
import { QUERIES } from "../src/sql.ts";
import { analysis } from "./fixture.ts";

const KNOBS = [
  "autovacuum_freeze_max_age",
  "autovacuum_multixact_freeze_max_age",
  "vacuum_freeze_min_age",
  "vacuum_freeze_table_age",
  "autovacuum_max_workers",
  "autovacuum_naptime",
  "autovacuum_vacuum_cost_delay",
  "autovacuum_vacuum_cost_limit",
  "hot_standby_feedback",
];

describe("Task 6 - the freeze knobs are in the pgSettings allowlist", () => {
  for (const k of KNOBS) {
    test(`pgSettings collects ${k}`, () => {
      expect(QUERIES.pgSettings).toContain(k);
    });
  }

  test("the existing allowlist entries are untouched", () => {
    for (const k of ["work_mem", "statement_timeout", "log_lock_waits", "data_checksums"]) {
      expect(QUERIES.pgSettings).toContain(k);
    }
  });
});

const settings = (rows: Array<[string, string]>) =>
  analysis((raw) => {
    raw.sql.pgSettings = rows.map(([name, setting]) => ({ name, setting, unit: null }));
  });

describe("Task 6 - broken freeze configuration is a finding", () => {
  test("autovacuum off is high severity - nothing will ever freeze", () => {
    const a = settings([
      ["autovacuum", "off"],
      ["autovacuum_freeze_max_age", "200000000"],
    ]);
    const f = [...configTuningFindings(a), ...deriveFindings(a)].find(
      (x) => x.heuristicId === "autovacuum_freeze_tuning",
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe("high");
  });

  test("a freeze_max_age past the blocked-freeze threshold is flagged", () => {
    const a = settings([
      ["autovacuum", "on"],
      ["autovacuum_freeze_max_age", "2000000000"],
    ]);
    const f = [...configTuningFindings(a), ...deriveFindings(a)].find(
      (x) => x.heuristicId === "autovacuum_freeze_tuning",
    );
    expect(f).toBeDefined();
  });

  test("the Postgres default configuration is NOT flagged", () => {
    const a = settings([
      ["autovacuum", "on"],
      ["autovacuum_freeze_max_age", "200000000"],
      ["autovacuum_multixact_freeze_max_age", "400000000"],
    ]);
    const f = [...configTuningFindings(a), ...deriveFindings(a)].find(
      (x) => x.heuristicId === "autovacuum_freeze_tuning",
    );
    expect(f).toBeUndefined();
  });
});
