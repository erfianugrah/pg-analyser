// Acceptance - plan Task 8: parse the server log's own wraparound warnings.
// Contract only. Do not edit to make the implementation pass.
//
// The two upstream-documented strings are quoted verbatim from
// /docs/postgres/routine-vacuuming.md; the other two patterns are field
// wordings and the parser must be tolerant of surrounding decoration.
import { describe, expect, test } from "bun:test";
import { parseFreezeLog } from "../src/freezelog.ts";

const LOG = [
  "2026-08-01 03:14:15 UTC [1234] LOG:  checkpoint starting: time",
  '2026-08-01 04:00:01 UTC [1234] WARNING:  database "postgres" must be vacuumed within 39985967 transactions',
  "2026-08-01 04:00:01 UTC [1234] HINT:  To avoid XID assignment failures, execute a database-wide VACUUM in that database.",
  '2026-08-02 04:00:02 UTC [1234] WARNING:  database "postgres" must be vacuumed within 21000000 transactions',
  "2026-08-02 05:00:03 UTC [9999] WARNING:  oldest xmin is far in the past",
  '2026-08-02 06:00:04 UTC [8888] LOG:  automatic aggressive vacuum to prevent wraparound of table "postgres.public.events": index scans: 1',
].join("\n");

describe("Task 8 - parseFreezeLog", () => {
  test("returns null for a log with no freeze evidence", () => {
    expect(parseFreezeLog("2026-08-01 03:14:15 UTC [1] LOG:  checkpoint complete")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseFreezeLog("")).toBeNull();
  });

  test("keeps the WORST (smallest) must-be-vacuumed-within value", () => {
    expect(parseFreezeLog(LOG)?.mustVacuumWithin).toBe(21_000_000);
  });

  test("counts the oldest-xmin warnings", () => {
    expect(parseFreezeLog(LOG)?.oldestXminWarnings).toBe(1);
  });

  test("counts anti-wraparound vacuums and names the relation", () => {
    const r = parseFreezeLog(LOG);
    expect(r?.antiWraparoundVacuums).toBe(1);
    expect(r?.relations.join(" ")).toContain("public.events");
  });

  test("keeps a bounded sample of the matching lines as evidence", () => {
    const r = parseFreezeLog(LOG);
    expect(Array.isArray(r?.samples)).toBe(true);
    expect((r?.samples ?? []).length).toBeGreaterThan(0);
    expect((r?.samples ?? []).length).toBeLessThanOrEqual(20);
  });

  test("a huge log does not blow up and stays bounded", () => {
    const big = `${Array.from({ length: 5000 }, (_, i) => `line ${i} LOG:  nothing`).join("\n")}\n${LOG}`;
    const r = parseFreezeLog(big);
    expect(r?.mustVacuumWithin).toBe(21_000_000);
    expect((r?.samples ?? []).length).toBeLessThanOrEqual(20);
  });
});
