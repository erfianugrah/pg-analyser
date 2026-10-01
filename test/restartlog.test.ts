import { describe, expect, test } from "bun:test";
import { parseRestartLog } from "../src/restartlog.ts";

// Message text is verbatim from postgres:17.11-alpine / 17.4-alpine runs on
// 2026-10-01 (supabase-lab checkpointer-reset RUNLOG), stderr format. Some
// timestamps are illustrative where the run output did not show that line's
// time (the stop-request lines, and the whole CRASH fixture, which is
// synthetic: no crash was induced in those runs).
const CLEAN = [
  "2026-10-01 08:02:12.600 UTC [27] LOG:  received fast shutdown request",
  "2026-10-01 08:02:12.637 UTC [28] LOG:  checkpoint starting: shutdown immediate",
  "2026-10-01 08:02:15.193 UTC [28] LOG:  checkpoint complete: wrote 261855 buffers (99.9%); 0 WAL file(s) added",
  "2026-10-01 08:02:15.573 UTC [27] LOG:  database system is shut down",
  "2026-10-01 08:02:16.663 UTC [133] LOG:  database system was shut down at 2026-10-01 08:02:14 UTC",
];
const KILLED_ALL = [
  "2026-10-01 08:03:08.010 UTC [220] LOG:  received fast shutdown request",
  "2026-10-01 08:03:08.080 UTC [221] LOG:  checkpoint starting: shutdown immediate",
  "2026-10-01 08:03:11.039 UTC [314] LOG:  database system shutdown was interrupted; last known up at 2026-10-01 08:03:08 UTC",
  "2026-10-01 08:03:12.089 UTC [314] LOG:  database system was not properly shut down; automatic recovery in progress",
  "2026-10-01 08:03:12.093 UTC [314] LOG:  redo starts at 1/BF05FBB0",
];
const KILLED_POSTMASTER = [
  "2026-10-01 08:07:22.900 UTC [82] LOG:  received fast shutdown request",
  "2026-10-01 08:07:23.474 UTC [83] LOG:  checkpoint starting: shutdown immediate",
  "2026-10-01 08:07:25.085 UTC [83] LOG:  checkpoint complete: wrote 261963 buffers (99.9%)",
  "2026-10-01 08:07:32.347 UTC [144] LOG:  database system was shut down at 2026-10-01 08:07:24 UTC",
];
const CRASH = [
  "2026-10-01 09:00:00.000 UTC [10] LOG:  database system was interrupted; last known up at 2026-10-01 08:58:01 UTC",
  "2026-10-01 09:00:00.500 UTC [10] LOG:  database system was not properly shut down; automatic recovery in progress",
];

describe("parseRestartLog", () => {
  test("returns null only when no matched line has a timestamp", () => {
    expect(parseRestartLog("")).toBeNull();
    expect(parseRestartLog("LOG:  checkpoint complete: wrote 3 buffers")).toBeNull();
  });

  test("no restart in the text still reports the span it covered", () => {
    const s = parseRestartLog(
      [
        "2026-10-01 08:00:00 UTC [1] LOG:  checkpoint complete: wrote 3 buffers",
        "2026-10-01 09:15:00 UTC [1] LOG:  checkpoint complete: wrote 9 buffers",
      ].join("\n"),
    )!;
    expect(s.total).toBe(0);
    expect(s.restarts).toEqual([]);
    expect(s.coverage).toEqual({ from: "2026-10-01 08:00:00", to: "2026-10-01 09:15:00" });
  });

  test("a non-UTC log offset is converted, so times are UTC", () => {
    // Verbatim shape from a PG 18.6 cluster logging in +08 (2026-10-01).
    const s = parseRestartLog(
      [
        "2026-10-01 17:36:30.818 +08 [687973] LOG:  received fast shutdown request",
        "2026-10-01 17:36:30.827 +08 [687973] LOG:  database system is shut down",
        "2026-10-01 17:36:30.973 +08 [688017] LOG:  database system was shut down at 2026-10-01 17:36:30 +08",
      ].join("\n"),
    )!;
    expect(s.restarts[0]!.at).toBe("2026-10-01 09:36:30");
    expect(s.restarts[0]!.verdict).toBe("clean");
  });

  test("a stop that logged 'database system is shut down' then a clean start is clean", () => {
    const s = parseRestartLog(CLEAN.join("\n"))!;
    expect(s.restarts).toHaveLength(1);
    expect(s.restarts[0]).toMatchObject({
      stopMode: "fast",
      shutdownCheckpoint: "completed",
      shutDownLogged: true,
      startup: "clean",
      verdict: "clean",
    });
  });

  test("a fast shutdown followed by crash recovery is a cut-off stop", () => {
    const r = parseRestartLog(KILLED_ALL.join("\n"))!.restarts[0]!;
    expect(r.shutdownCheckpoint).toBe("started");
    expect(r.shutDownLogged).toBe(false);
    expect(r.startup).toBe("recovery");
    expect(r.verdict).toBe("stop_cut_off_recovered");
    expect(r.stopAt).toBe("2026-10-01 08:03:08");
    expect(r.at).toBe("2026-10-01 08:03:11");
  });

  test("checkpoint finished but no 'is shut down' line, then a clean start", () => {
    const r = parseRestartLog(KILLED_POSTMASTER.join("\n"))!.restarts[0]!;
    expect(r.shutdownCheckpoint).toBe("completed");
    expect(r.shutDownLogged).toBe(false);
    expect(r.startup).toBe("clean");
    expect(r.verdict).toBe("stop_cut_off_clean_start");
  });

  test("crash recovery with no shutdown request before it is a crash", () => {
    const r = parseRestartLog(CRASH.join("\n"))!.restarts[0]!;
    expect(r.stopMode).toBeNull();
    expect(r.verdict).toBe("crash");
  });

  test("a clean start whose stop side is outside the scanned text says so", () => {
    const r = parseRestartLog(CLEAN[4]!)!.restarts[0]!;
    expect(r.stopMode).toBeNull();
    expect(r.verdict).toBe("clean_stop_unseen");
  });

  test("chunks joined newest-file-first are put back in time order", () => {
    // collect.ts joins file tails newest first; a later restart's lines arrive
    // before an earlier one's.
    const s = parseRestartLog([...KILLED_ALL, ...CLEAN].join("\n"))!;
    expect(s.restarts.map((r) => r.verdict)).toEqual(["clean", "stop_cut_off_recovered"]);
  });

  test("csvlog format parses the same messages", () => {
    const csv = KILLED_ALL.map((l) => {
      const ts = l.slice(0, 23);
      const msg = l.split("LOG:  ")[1];
      return `${ts} UTC,,,314,,,,,,,LOG,00000,"${msg}",,,,,,,,,""`;
    });
    expect(parseRestartLog(csv.join("\n"))!.restarts[0]!.verdict).toBe("stop_cut_off_recovered");
  });

  test("keeps no raw log text - only parsed timestamps and enums", () => {
    const s = parseRestartLog(
      CLEAN.map((l) => `${l} ,,"SELECT secret FROM private_t"`).join("\n"),
    )!;
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(JSON.stringify(s)).not.toContain("private_t");
  });

  test("caps the restart list and reports the total", () => {
    const many: string[] = [];
    for (let d = 1; d <= 28; d++) {
      const day = String(d).padStart(2, "0");
      many.push(
        `2026-09-${day} 01:00:00.000 UTC [1] LOG:  database system was shut down at 2026-09-${day} 00:59:59 UTC`,
      );
    }
    const s = parseRestartLog(many.join("\n"))!;
    expect(s.total).toBe(28);
    expect(s.restarts.length).toBeLessThanOrEqual(20);
    // newest kept
    expect(s.restarts[s.restarts.length - 1]!.at).toBe("2026-09-28 01:00:00");
  });
});
