import { describe, expect, test } from "bun:test";
import { parseLockLog } from "../src/locklog.ts";

// Synthetic csvlog lines (NO real table/query text). The message field is the
// 14th csv column in Postgres csvlog; the parser matches embedded message text
// so it is format-agnostic (csvlog or stderr).
const CSVLOG = [
  `2026-07-15 18:15:46.123 UTC,,,123,,,,,,LOG,00000,"process 123 still waiting for ShareLock on relation 12345 of database 5 after 1000.000 ms",,,,,,,,,`,
  `2026-07-15 18:18:02.500 UTC,,,124,,,,,,LOG,00000,"process 124 acquired AccessExclusiveLock on relation 12345 of database 5 after 334061.247 ms",,,,,`,
  `2026-07-15 18:19:10.000 UTC,,,125,,,,,,ERROR,57014,"canceling statement due to lock timeout",,,,,`,
  `2026-07-15 18:19:11.000 UTC,,,126,,,,,,ERROR,57014,"canceling statement due to statement timeout",,,,,`,
  `2026-07-15 18:20:00.000 UTC,,,127,,,,,,ERROR,40P01,"deadlock detected",,,,,`,
].join("\n");

const COV = {
  from: "2026-07-15 18:15",
  to: "2026-07-15 18:20",
  files: 1,
  bytesScanned: CSVLOG.length,
};

describe("parseLockLog", () => {
  test("parses waiting/acquired/cancels/deadlock into minute buckets", () => {
    const s = parseLockLog(CSVLOG, COV);
    expect(s.buckets.find((b) => b.minute === "2026-07-15 18:15")?.waiting).toBe(1);
    expect(s.buckets.find((b) => b.minute === "2026-07-15 18:18")?.maxWaitMs).toBeCloseTo(
      334061.247,
      1,
    );
    const b19 = s.buckets.find((b) => b.minute === "2026-07-15 18:19");
    expect(b19?.cancelsLock).toBe(1);
    expect(b19?.cancelsStmt).toBe(1);
    expect(s.buckets.find((b) => b.minute === "2026-07-15 18:20")?.deadlocks).toBe(1);
    expect(s.topRelations[0]?.relid).toBe(12345);
    expect(s.topRelations[0]?.hits).toBe(2); // waiting + acquired
  });

  test("stderr prefix + unparseable timestamp falls back to a 'window' bucket", () => {
    const line = `process 9 still waiting for ShareLock on relation 999 of database 5 after 50.0 ms`;
    const s = parseLockLog(line, { from: null, to: null, files: 1, bytesScanned: line.length });
    expect(s.buckets[0]?.minute).toBe("window");
    expect(s.buckets[0]?.waiting).toBe(1);
  });

  test("non-lock lines are ignored (no spurious buckets)", () => {
    const s = parseLockLog(
      `2026-07-15 18:00:00.000 UTC,,,1,,,,,,LOG,00000,"connection authorized: user=x",,,,`,
      { from: null, to: null, files: 1, bytesScanned: 1 },
    );
    expect(s.buckets.length).toBe(0);
    expect(s.samples.length).toBe(0);
  });

  test("samples are capped at 5, literal-free (reconstructed), and <=200 chars", () => {
    // The trailing 'x' run stands in for a leaked query literal / secret / PII
    // in the raw csvlog line. Samples must be reconstructed from the match, so
    // NONE of that tail may appear.
    const long = Array.from(
      { length: 20 },
      (_, i) =>
        `2026-07-15 18:15:0${i % 10} UTC,,,${i},,,,,,ERROR,57014,"canceling statement due to lock timeout",,,"UPDATE t SET x='${"x".repeat(400)}'"`,
    ).join("\n");
    const s = parseLockLog(long, COV);
    expect(s.samples.length).toBeLessThanOrEqual(5);
    expect(Math.max(...s.samples.map((x) => x.length))).toBeLessThanOrEqual(200);
    // No sample may contain the raw statement column (no query text / literal).
    expect(s.samples.every((x) => !x.includes("UPDATE t SET"))).toBe(true);
    expect(s.samples.every((x) => !x.includes("xxxx"))).toBe(true);
    expect(s.samples[0]).toContain("canceling statement due to lock timeout");
  });

  test("a waiting line with a trailing query column yields only the lock phrase", () => {
    const line = `2026-07-15 18:15:00.000 UTC,,,1,,,,,,LOG,00000,"process 1 still waiting for ShareLock on relation 12345 of database 5 after 1000.000 ms",,,,"SELECT secret_col FROM private_t WHERE ssn='123-45-6789'"`;
    const sample = parseLockLog(line, COV).samples[0] ?? "";
    expect(sample).toContain("still waiting for ShareLock on relation 12345");
    expect(sample).not.toContain("ssn");
    expect(sample).not.toContain("secret_col");
    expect(sample).not.toContain("private_t");
  });

  test("cancelsUser is captured but distinct from timeout cancels", () => {
    const line = `2026-07-15 18:21:00.000 UTC,,,1,,,,,,ERROR,57014,"canceling statement due to user request",,,`;
    const b = parseLockLog(line, COV).buckets[0];
    expect(b?.cancelsUser).toBe(1);
    expect(b?.cancelsLock).toBe(0);
    expect(b?.cancelsStmt).toBe(0);
  });
});

import { classifyLockWave } from "../src/locklog.ts";

function summaryOf(
  buckets: Array<Partial<import("../src/locklog.ts").LockWaveBucket> & { minute: string }>,
) {
  return {
    coverage: { from: null, to: null, files: 1, bytesScanned: 1 },
    buckets: buckets.map((b) => ({
      waiting: 0,
      maxWaitMs: 0,
      acquired: 0,
      cancelsLock: 0,
      cancelsStmt: 0,
      cancelsUser: 0,
      deadlocks: 0,
      ...b,
    })),
    topRelations: [],
    samples: [],
  };
}

describe("classifyLockWave (wall-clock windowing)", () => {
  test("sparse background noise (2 cancels every 15min for 2h) does NOT fire", () => {
    // The real-world false-positive case: 8 buckets 15min apart, 2 stmt-cancels
    // each. A 10-MINUTE wall-clock window contains at most one bucket (2 cancels),
    // well under the MED threshold of 10 - so nothing should fire.
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      minute: `2026-07-15 ${String(20 + Math.floor((i * 15) / 60)).padStart(2, "0")}:${String((i * 15) % 60).padStart(2, "0")}`,
      cancelsStmt: 2,
    }));
    expect(classifyLockWave(summaryOf(buckets))).toBeNull();
  });

  test("a real cascade (50 cancels within 10 wall-clock minutes) fires HIGH", () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      minute: `2026-07-15 18:${String(15 + i).padStart(2, "0")}`,
      cancelsStmt: 5, // 50 across a 10-minute span
    }));
    const v = classifyLockWave(summaryOf(buckets));
    expect(v?.severity).toBe("high");
    expect(v?.cancels).toBeGreaterThanOrEqual(50);
  });

  test("the window label reflects real minutes, not a 2h bucket span", () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      minute: `2026-07-15 18:${String(15 + i).padStart(2, "0")}`,
      cancelsStmt: 5,
    }));
    const v = classifyLockWave(summaryOf(buckets))!;
    // window spans 18:15..18:24 (<=10 min), never 2 hours
    expect(v.windowFrom).toBe("2026-07-15 18:15");
    expect(Number(v.windowTo.slice(-2))).toBeLessThanOrEqual(24);
  });
});
