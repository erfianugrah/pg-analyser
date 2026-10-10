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

  test("a real cascade (50 cancels within 10 wall-clock minutes, with lock waits) fires HIGH", () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      minute: `2026-07-15 18:${String(15 + i).padStart(2, "0")}`,
      waiting: 1,
      cancelsLock: 2,
      cancelsStmt: 3, // 50 cancels across a 10-minute span, lock evidence present
    }));
    const v = classifyLockWave(summaryOf(buckets));
    expect(v?.kind).toBe("cascade");
    expect(v?.severity).toBe("high");
    expect(v?.cancels).toBeGreaterThanOrEqual(50);
  });

  test("statement-timeout cancels with NO lock line are a stmt_timeout burst, not a cascade", () => {
    // Measured shape: 49 + 25 statement cancels in two adjacent minutes, zero
    // waits, zero lock-timeout cancels, zero deadlocks - was titled a HIGH
    // "Lock-wait cascade ... 0 waits up to 0s".
    const v = classifyLockWave(
      summaryOf([
        { minute: "2026-09-03 03:05", cancelsStmt: 49 },
        { minute: "2026-09-03 03:06", cancelsStmt: 25 },
      ]),
    );
    expect(v?.kind).toBe("stmt_timeout");
    expect(v?.severity).toBe("med");
    expect(v?.cancelsStmt).toBe(74);
    expect(v?.cancelsLock).toBe(0);
    // 10..49 statement cancels -> low
    expect(
      classifyLockWave(summaryOf([{ minute: "2026-09-03 08:34", cancelsStmt: 14 }]))?.severity,
    ).toBe("low");
    // under 10 -> nothing
    expect(
      classifyLockWave(summaryOf([{ minute: "2026-09-03 12:17", cancelsStmt: 6 }])),
    ).toBeNull();
  });

  test("a cascade in one window outranks a bigger stmt_timeout burst in another", () => {
    const v = classifyLockWave(
      summaryOf([
        { minute: "2026-09-03 03:05", cancelsStmt: 74 },
        { minute: "2026-09-03 14:10", waiting: 12, cancelsLock: 3 },
      ]),
    );
    expect(v?.kind).toBe("cascade");
    expect(v?.windowFrom).toBe("2026-09-03 14:10");
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

  test("a 'window' bucket (unparseable timestamps) is unresolved, not a literal 'window-window' range", () => {
    // Measured on a live report: every matching log line's timestamp failed
    // RE_TS, so every event folded into the "window" bucket - the verdict's
    // windowFrom/windowTo were then the literal string "window" twice,
    // rendering the title "Lock-wait cascade window-window: ...".
    const s = {
      coverage: { from: "2024-09-28 02:30", to: "2024-09-28 04:05", files: 3, bytesScanned: 11e6 },
      buckets: [
        {
          minute: "window",
          waiting: 0,
          maxWaitMs: 0,
          acquired: 0,
          cancelsLock: 1,
          cancelsStmt: 25,
          cancelsUser: 0,
          deadlocks: 0,
        },
      ],
      topRelations: [],
      samples: [],
    };
    const v = classifyLockWave(s)!;
    expect(v.windowResolved).toBe(false);
    // The bucket spans the whole scan, not a 10-minute window, so the 10-minute
    // thresholds can't grade it: 26 cancels would read MED, capped at low.
    expect(v.severity).toBe("low");
    // windowFrom/windowTo fall back to the overall scanned coverage span, not
    // the "window" sentinel, so a caller that ignores windowResolved still
    // doesn't render the literal placeholder.
    expect(v.windowFrom).toBe("2024-09-28 02:30");
    expect(v.windowTo).toBe("2024-09-28 04:05");
  });

  test("a 'window' bucket with no coverage span either falls back to an honest label, not 'window'", () => {
    const s = {
      coverage: { from: null, to: null, files: 1, bytesScanned: 1 },
      buckets: [
        {
          minute: "window",
          waiting: 0,
          maxWaitMs: 0,
          acquired: 0,
          cancelsLock: 0,
          cancelsStmt: 12,
          cancelsUser: 0,
          deadlocks: 0,
        },
      ],
      topRelations: [],
      samples: [],
    };
    const v = classifyLockWave(s)!;
    expect(v.windowResolved).toBe(false);
    expect(v.windowFrom).not.toBe("window");
    expect(v.windowTo).not.toBe("window");
  });
});

// ---------------------------------------------------------------------------
// WHO waited for WHAT (2026-10-10). Full 26-column csvlog rows: application_name
// is column 23 (0-based 22), AFTER the multi-line `query` column, so the
// parser has to assemble the record before reading it.
// ---------------------------------------------------------------------------
function csvRow(o: {
  ts: string;
  user?: string;
  pid: number;
  sev?: string;
  state?: string;
  msg: string;
  detail?: string;
  query?: string;
  app?: string;
}): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const f: string[] = Array(26).fill("");
  f[0] = o.ts;
  f[1] = o.user ?? "";
  f[2] = "appdb";
  f[3] = String(o.pid);
  f[11] = o.sev ?? "LOG";
  f[12] = o.state ?? "00000";
  f[13] = q(o.msg);
  f[14] = o.detail ? q(o.detail) : "";
  f[19] = o.query ? q(o.query) : "";
  f[22] = o.app ?? "";
  return f.join(",");
}
const WAIT = (pid: number, ms = "1000.058", mode = "AccessShareLock", rel = 30919) =>
  `process ${pid} still waiting for ${mode} on relation ${rel} of database 5 after ${ms} ms`;

describe("parseLockLog wait events (who waited for what)", () => {
  test("keeps waiter pid, mode, relid, holders, wait queue, wait ms, application_name and user_name", () => {
    const text = csvRow({
      ts: "2026-10-09 00:22:10.100 UTC",
      user: "authenticator",
      pid: 123,
      msg: WAIT(123),
      detail: "Process holding the lock: 456. Wait queue: 123, 789.",
      query: "SELECT secret_col FROM public.orders WHERE ssn='123-45-6789'",
      app: "PostgREST 12.2",
    });
    const e = parseLockLog(text, COV).buckets[0]?.events?.[0];
    expect(e).toMatchObject({
      minute: "2026-10-09 00:22",
      kind: "waiting",
      mode: "AccessShareLock",
      relid: 30919,
      relation: null,
      pid: 123,
      holders: [456],
      queue: [123, 789],
      appName: "PostgREST 12.2",
      userName: "authenticator",
    });
    expect(e?.waitMs).toBeCloseTo(1000.058, 3);
    // PRIVACY: the statement column stays out of analysis.json.
    const blob = JSON.stringify(parseLockLog(text, COV));
    expect(blob).not.toContain("ssn");
    expect(blob).not.toContain("secret_col");
  });

  test("a multi-line query column before application_name does not lose the application_name", () => {
    const text = csvRow({
      ts: "2026-10-09 00:22:10.100 UTC",
      user: "postgres",
      pid: 7,
      msg: WAIT(7),
      detail: "Processes holding the lock: 8, 9. Wait queue: 7.",
      query: "select 1\nfrom public.orders\nwhere x = 'a'",
      app: "pg-analyser",
    });
    const e = parseLockLog(text, COV).buckets[0]?.events?.[0];
    expect(e?.appName).toBe("pg-analyser");
    expect(e?.holders).toEqual([8, 9]);
  });

  test("an acquired line is an event with kind 'acquired' and no holders", () => {
    const text = csvRow({
      ts: "2026-10-09 00:23:00.000 UTC",
      user: "postgres",
      pid: 123,
      msg: "process 123 acquired AccessShareLock on relation 30919 of database 5 after 2000.5 ms",
      app: "psql",
    });
    const e = parseLockLog(text, COV).buckets[0]?.events?.[0];
    expect(e?.kind).toBe("acquired");
    expect(e?.holders).toEqual([]);
    expect(e?.waitMs).toBeCloseTo(2000.5, 1);
  });

  test("a holder pid's application_name is taken from any other row that pid logged", () => {
    const text = [
      csvRow({
        ts: "2026-10-09 00:10:00.000 UTC",
        user: "postgres",
        pid: 456,
        msg: "connection authorized: user=postgres database=appdb",
        app: "pg-analyser",
      }),
      csvRow({
        ts: "2026-10-09 00:22:10.100 UTC",
        user: "authenticator",
        pid: 123,
        msg: WAIT(123),
        detail: "Process holding the lock: 456. Wait queue: 123.",
        app: "PostgREST 12.2",
      }),
    ].join("\n");
    const e = parseLockLog(text, COV).buckets[0]?.events?.[0];
    expect(e?.holderApps).toEqual(["pg-analyser"]);
  });

  test("stderr format: the DETAIL line on the next line supplies holders and queue", () => {
    const text = [
      "2026-10-09 00:22:10.100 UTC [123] LOG:  process 123 still waiting for ShareLock on relation 30919 of database 5 after 1000.058 ms",
      "2026-10-09 00:22:10.100 UTC [123] DETAIL:  Process holding the lock: 456. Wait queue: 123, 789.",
    ].join("\n");
    const e = parseLockLog(text, COV).buckets[0]?.events?.[0];
    expect(e?.pid).toBe(123);
    expect(e?.holders).toEqual([456]);
    expect(e?.queue).toEqual([123, 789]);
    expect(e?.appName).toBeNull();
  });

  test("events per bucket are capped at 20", () => {
    const text = Array.from({ length: 30 }, (_, i) =>
      csvRow({ ts: "2026-10-09 00:22:10.100 UTC", user: "u", pid: 100 + i, msg: WAIT(100 + i) }),
    ).join("\n");
    const b = parseLockLog(text, COV).buckets[0];
    expect(b?.waiting).toBe(30);
    expect(b?.events?.length).toBe(20);
  });

  test("classifyLockWave carries the window's events (<=20) on the verdict", () => {
    const text = Array.from({ length: 12 }, (_, i) =>
      csvRow({
        ts: `2026-10-09 00:2${i % 3}:10.100 UTC`,
        user: "u",
        pid: 100 + i,
        msg: WAIT(100 + i),
      }),
    ).join("\n");
    const v = classifyLockWave(parseLockLog(text, COV));
    expect(v?.kind).toBe("cascade");
    expect(v?.events?.length).toBe(12);
    expect(v?.events?.[0]?.pid).toBe(100);
  });

  test("an analysis.json written before events existed still parses", async () => {
    const { Analysis } = await import("../src/schemas.ts");
    const old = {
      coverage: { from: null, to: null, files: 1, bytesScanned: 1 },
      buckets: [
        {
          minute: "2026-10-09 00:22",
          waiting: 1,
          maxWaitMs: 5,
          acquired: 0,
          cancelsLock: 0,
          cancelsStmt: 0,
          cancelsUser: 0,
          deadlocks: 0,
        },
      ],
      topRelations: [],
      samples: [],
    };
    expect(Analysis.shape.sql.shape.lockWave.parse(old)).not.toBeNull();
  });
});

describe("classifyLockWave: background statement cancels do not inflate a cascade", () => {
  // Anonymised shape from a real report: 90 minutes with 1-2 statement-timeout
  // cancels per minute (platform background), 1 lock wait at minute 50 and 4
  // (max 11.6 s) at minute 52. The old grade summed the background cancels over
  // the 10-minute window (>= 10) because the window had lock evidence, and
  // titled it a MED cascade with "10 timeout cancellations".
  const minuteAt = (m: number) =>
    `2026-10-09 ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const buckets = Array.from({ length: 90 }, (_, m) => ({
    minute: minuteAt(m),
    cancelsStmt: 1 + (m % 2),
    waiting: m === 50 ? 1 : m === 52 ? 4 : 0,
    maxWaitMs: m === 50 ? 2000 : m === 52 ? 11_600 : 0,
    acquired: m === 52 ? 2 : 0,
  }));

  test("5 waits + steady background statement cancels is not a MED cascade", () => {
    const v = classifyLockWave(summaryOf(buckets));
    // Counted statement cancels = only those in minutes 50 and 52 (<= 4), waits = 5:
    // under every cascade threshold, so no cascade verdict at all. What remains
    // is the separate background statement_timeout signal (kind stmt_timeout).
    expect(v?.kind === "cascade" && v.severity !== "low").toBe(false);
    expect(v?.kind).not.toBe("cascade");
  });

  test("statement cancels in a minute that has a wait still count toward a cascade", () => {
    const v = classifyLockWave(
      summaryOf([{ minute: "2026-10-09 00:20", waiting: 1, maxWaitMs: 3000, cancelsStmt: 12 }]),
    );
    expect(v?.kind).toBe("cascade");
    expect(v?.severity).toBe("med");
    expect(v?.cancelsStmt).toBe(12);
  });

  test("lock-timeout cancels still count everywhere in the window", () => {
    const v = classifyLockWave(
      summaryOf([
        { minute: "2026-10-09 00:20", cancelsLock: 5 },
        { minute: "2026-10-09 00:23", cancelsLock: 5 },
      ]),
    );
    expect(v?.kind).toBe("cascade");
    expect(v?.cancelsLock).toBe(10);
  });

  test("background statement cancels sharing a window with lock evidence are reported separately", () => {
    const v = classifyLockWave(
      summaryOf([
        { minute: "2026-10-09 00:20", waiting: 12, maxWaitMs: 3000 },
        { minute: "2026-10-09 00:21", cancelsStmt: 9 },
        { minute: "2026-10-09 00:22", cancelsStmt: 9 },
      ]),
    );
    expect(v?.kind).toBe("cascade");
    expect(v?.cancelsStmt).toBe(0);
    expect(v?.cancelsStmtBackground).toBe(18);
  });
});
