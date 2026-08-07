import { describe, expect, test } from "bun:test";
import { parseFreezeLog } from "../src/freezelog.ts";

describe("parseFreezeLog", () => {
  test("returns null for a log with no freeze evidence", () => {
    expect(parseFreezeLog("2026-08-01 03:14:15 UTC [1] LOG:  checkpoint complete")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseFreezeLog("")).toBeNull();
  });

  test("extracts the smallest must-be-vacuumed-within value", () => {
    const log = [
      '2026-08-01 04:00:01 UTC [1234] WARNING:  database "postgres" must be vacuumed within 39985967 transactions',
      '2026-08-02 04:00:02 UTC [1234] WARNING:  database "postgres" must be vacuumed within 21000000 transactions',
    ].join("\n");
    expect(parseFreezeLog(log)?.mustVacuumWithin).toBe(21000000);
  });

  test("counts the oldest-xmin warnings", () => {
    const log = [
      "2026-08-02 05:00:03 UTC [9999] WARNING:  oldest xmin is far in the past",
      "2026-08-02 05:05:04 UTC [9999] WARNING:  oldest xmin is far in the past",
    ].join("\n");
    expect(parseFreezeLog(log)?.oldestXminWarnings).toBe(2);
  });

  test("counts anti-wraparound vacuums and extracts relation names", () => {
    const log =
      '2026-08-02 06:00:04 UTC [8888] LOG:  automatic aggressive vacuum to prevent wraparound of table "postgres.public.events": index scans: 1';
    const r = parseFreezeLog(log);
    expect(r?.antiWraparoundVacuums).toBe(1);
    expect(r?.relations.join(" ")).toContain("public.events");
  });

  test("keeps a bounded sample of matching lines as evidence", () => {
    const log = [
      '2026-08-01 04:00:01 UTC [1234] WARNING:  database "postgres" must be vacuumed within 39985967 transactions',
      "2026-08-02 05:00:03 UTC [9999] WARNING:  oldest xmin is far in the past",
    ].join("\n");
    const r = parseFreezeLog(log);
    expect(Array.isArray(r?.samples)).toBe(true);
    expect((r?.samples ?? []).length).toBeGreaterThan(0);
  });

  test("does not blow up on a very large log and keeps samples bounded", () => {
    const big = `${Array.from({ length: 5000 }, (_, i) => `line ${i} LOG:  nothing`).join("\n")}
2026-08-01 04:00:01 UTC [1234] WARNING:  database "postgres" must be vacuumed within 21000000 transactions`;
    const r = parseFreezeLog(big);
    expect(r?.mustVacuumWithin).toBe(21000000);
    expect((r?.samples ?? []).length).toBeLessThanOrEqual(20);
  });
});

describe("bounded output", () => {
  test("relations are capped so a wide anti-wraparound sweep cannot bloat the report", () => {
    // Measured: one forced-autovacuum pass on a real cluster logged 320 lines
    // naming ~160 distinct relations.
    const log = Array.from(
      { length: 300 },
      (_, i) =>
        `2026-08-07 10:17:50 UTC [1] LOG:  automatic aggressive vacuum to prevent wraparound of table "db.public.t${i}": index scans: 0`,
    ).join("\n");
    const r = parseFreezeLog(log);
    expect(r?.antiWraparoundVacuums).toBe(300);
    expect((r?.relations ?? []).length).toBeLessThanOrEqual(20);
    expect((r?.samples ?? []).length).toBeLessThanOrEqual(20);
  });
});
