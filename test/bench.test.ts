import { describe, expect, test } from "bun:test";
import {
  diffGucs,
  median,
  parseConnstring,
  parsePgbenchLog,
  parseStdoutSummary,
  percentile,
  renderCompareText,
  renderListText,
  renderShowText,
  scriptHash,
  spreadPct,
  summarizeRun,
} from "../src/bench.ts";
import { type BenchRunInput, HistoryStore } from "../src/store.ts";

describe("parsePgbenchLog", () => {
  test("extracts microsecond latencies from the standard 6-field format", () => {
    const log = [
      "0 199 2241 0 1175850568 995598",
      "0 200 2465 0 1175850568 998079",
      "0 201 2513 0 1175850569 608",
    ].join("\n");
    const r = parsePgbenchLog(log);
    expect(r.latenciesUs).toEqual([2241, 2465, 2513]);
    expect(r.failedTx).toBe(0);
    expect(r.skippedTx).toBe(0);
  });

  test("ignores extra trailing columns (schedule_lag, retries)", () => {
    const log = [
      "0 81 4621 0 1412881037 912698 3005", // --rate: schedule_lag present
      "3 0 47423 0 1499414498 34501 3", // --max-tries: retries present
    ].join("\n");
    const r = parsePgbenchLog(log);
    expect(r.latenciesUs).toEqual([4621, 47423]);
  });

  test("counts skipped (rate mode) and failed/serialization/deadlock separately", () => {
    const log = [
      "0 83 skipped 0 1412881037 914578 5217",
      "1 0 failed 0 1499414498 84905 9",
      "2 0 serialization 0 1499414498 86248 9",
      "3 0 deadlock 0 1499414498 86249 1",
      "0 84 4142 0 1412881037 918023 2333",
      "",
    ].join("\n");
    const r = parsePgbenchLog(log);
    expect(r.latenciesUs).toEqual([4142]);
    expect(r.skippedTx).toBe(1);
    expect(r.failedTx).toBe(3);
  });
});

describe("parseStdoutSummary", () => {
  test("extracts tps and failed count", () => {
    const out = [
      "number of failed transactions: 0 (0.000%)",
      "latency average = 1.231 ms",
      "tps = 812.345678 (without initial connection time)",
    ].join("\n");
    expect(parseStdoutSummary(out)).toEqual({ tps: 812.345678, failedTx: 0 });
  });
  test("returns nulls when lines are absent", () => {
    expect(parseStdoutSummary("garbage")).toEqual({ tps: null, failedTx: null });
  });
});

describe("percentile/median/spread", () => {
  test("nearest-rank percentiles", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });
  test("median of odd and even lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  test("spreadPct is (max-min)/median", () => {
    expect(spreadPct([100, 110, 120])).toBeCloseTo(18.18, 1);
    expect(spreadPct([100])).toBe(0);
  });
});

describe("summarizeRun", () => {
  test("computes percentiles from the log and takes tps from stdout", () => {
    const s = summarizeRun([1000, 2000, 3000, 4000], 1, 0, 42.5, 10);
    expect(s.tps).toBe(42.5);
    expect(s.p50Us).toBe(2000);
    expect(s.maxUs).toBe(4000);
    expect(s.failedTx).toBe(1);
    expect(s.tx).toBe(4);
  });
  test("falls back to count/time when stdout tps is missing", () => {
    const s = summarizeRun([1000, 1000, 1000, 1000], 0, 0, null, 2);
    expect(s.tps).toBe(2);
  });
});

describe("diffGucs", () => {
  test("changed, added, removed", () => {
    const d = diffGucs(
      { work_mem: "4MB", shared_buffers: "128MB", old_guc: "on" },
      { work_mem: "64MB", shared_buffers: "128MB", new_guc: "off" },
    );
    expect(d).toEqual([
      { name: "new_guc", from: null, to: "off" },
      { name: "old_guc", from: "on", to: null },
      { name: "work_mem", from: "4MB", to: "64MB" },
    ]);
  });
});

describe("scriptHash", () => {
  test("stable 12-char hex", () => {
    expect(scriptHash("SELECT 1")).toBe(scriptHash("SELECT 1"));
    expect(scriptHash("SELECT 1")).toMatch(/^[0-9a-f]{12}$/);
    expect(scriptHash("SELECT 1")).not.toBe(scriptHash("SELECT 2"));
  });
});

describe("parseConnstring", () => {
  test("splits a pooler-style connstring", () => {
    const c = parseConnstring(
      "postgresql://supabase_admin.abcdefgh:p%40ss@aws-1-region.pooler.supabase.com:5432/postgres",
    );
    expect(c).toEqual({
      host: "aws-1-region.pooler.supabase.com",
      port: "5432",
      user: "supabase_admin.abcdefgh",
      password: "p@ss",
      db: "postgres",
    });
  });
  test("defaults port 5432 and db postgres", () => {
    const c = parseConnstring("postgresql://u:p@db.example.com/");
    expect(c.port).toBe("5432");
    expect(c.db).toBe("postgres");
  });
});

function makeRun(over: Partial<BenchRunInput> = {}): BenchRunInput {
  return {
    ref: "abcdefghijklmnopqrsx",
    ts: 1_790_000_000,
    name: null,
    script_hash: "abc123def456",
    script_text: "SELECT 1",
    scale: 1,
    clients: 4,
    threads: 2,
    time_s: 60,
    protocol: "extended",
    rate: null,
    runs_json: "[]",
    tps_median: 812.3,
    p50_us: 4100,
    p95_us: 12900,
    p99_us: 30800,
    failed_tx: 0,
    guc_json: JSON.stringify({ work_mem: "4MB" }),
    client_cores: 8,
    client_load_max: 1.2,
    tainted: false,
    unstable: false,
    pgbench_version: "18.4",
    server_version: "17.6",
    ...over,
  };
}

describe("HistoryStore bench_runs", () => {
  test("record + list + get round trip", () => {
    const store = HistoryStore.open(":memory:");
    try {
      const id = store.recordBenchRun(makeRun({ name: "baseline" }));
      store.recordBenchRun(makeRun({ ref: "otherrefotherrefoth", script_hash: "zzz" }));
      const all = store.benchRuns();
      expect(all.length).toBe(2);
      const scoped = store.benchRuns("abcdefghijklmnopqrsx");
      expect(scoped.length).toBe(1);
      expect(scoped[0]!.id).toBe(id);
      const one = store.benchRun(id)!;
      expect(one.name).toBe("baseline");
      expect(one.guc).toEqual({ work_mem: "4MB" });
      expect(one.tainted).toBe(false);
      expect(store.benchRun(9999)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("renderCompareText", () => {
  test("shows stat deltas and the GUC diff", () => {
    const store = HistoryStore.open(":memory:");
    try {
      const aId = store.recordBenchRun(makeRun({ name: "baseline" }));
      const bId = store.recordBenchRun(
        makeRun({
          name: "work_mem 64MB",
          tps_median: 901.4,
          p95_us: 9400,
          guc_json: JSON.stringify({ work_mem: "64MB" }),
        }),
      );
      const text = renderCompareText(store.benchRun(aId)!, store.benchRun(bId)!);
      expect(text).toContain("baseline");
      expect(text).toContain("work_mem 64MB");
      expect(text).toContain("tps   812.3 -> 901.4  (11.0%)");
      expect(text).toContain("work_mem: 4MB -> 64MB");
      expect(text).not.toContain("WARNING: script differs");
    } finally {
      store.close();
    }
  });
  test("warns when the script differs between runs", () => {
    const store = HistoryStore.open(":memory:");
    try {
      const aId = store.recordBenchRun(makeRun());
      const bId = store.recordBenchRun(makeRun({ script_hash: "ffffffffffff" }));
      expect(renderCompareText(store.benchRun(aId)!, store.benchRun(bId)!)).toContain(
        "WARNING: script differs",
      );
    } finally {
      store.close();
    }
  });
});

describe("renderListText / renderShowText", () => {
  test("list shows one line per run with flags", () => {
    const store = HistoryStore.open(":memory:");
    try {
      store.recordBenchRun(makeRun({ name: "x", tainted: true }));
      const text = renderListText(store.benchRuns());
      expect(text).toContain("tainted");
      expect(text).toContain("x");
    } finally {
      store.close();
    }
  });
  test("show renders per-run detail", () => {
    const store = HistoryStore.open(":memory:");
    try {
      const id = store.recordBenchRun(
        makeRun({
          runs_json: JSON.stringify([
            {
              tps: 800,
              tx: 100,
              failedTx: 0,
              skippedTx: 0,
              latMeanUs: 5000,
              latStddevUs: 1000,
              p50Us: 4500,
              p95Us: 9000,
              p99Us: 12000,
              maxUs: 15000,
            },
          ]),
        }),
      );
      const text = renderShowText(store.benchRun(id)!);
      expect(text).toContain("run #1");
      expect(text).toContain("run 1: tps 800.0");
      expect(text).toContain("pg_settings captured: 1");
    } finally {
      store.close();
    }
  });
});
