import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { DirectSqlRunner } from "./sqlrunner.ts";
import type { BenchRunInput, BenchRunRow, HistoryStore } from "./store.ts";

/**
 * `sbperf bench` - a pgbench wrapper with methodology guardrails. pgbench does
 * the work; this adds the mechanizable half of good benchmarking: client-side
 * saturation checks, warmup + repetition with stability detection, exact
 * percentiles parsed from the per-transaction log (-l), a pg_settings snapshot
 * per run (so --compare shows the config delta next to the perf delta), and a
 * SQLite run history keyed by (ref, script). See docs/bench-design.md.
 *
 * Binary discovery mirrors report/pdf.ts's Chromium approach: SBPERF_PGBENCH
 * env, then PATH. pgbench talks the wire protocol, so a connstring is
 * required and no Management API planes are involved.
 */

export type BenchProtocol = "simple" | "extended" | "prepared";
export const BENCH_PROTOCOLS: BenchProtocol[] = ["simple", "extended", "prepared"];
export const BENCH_BUILTINS = ["tpcb-like", "simple-update", "select-only"] as const;

export type BenchOptions = {
  dbUrl: string;
  ref: string;
  scripts: string[]; // -f files, verbatim (may carry @weight)
  builtin: string; // used when scripts is empty
  scale: number;
  init: boolean;
  yes: boolean;
  clients: number;
  threads?: number; // default min(cores, clients)
  timeS: number;
  warmupS: number;
  runs: number;
  protocol: BenchProtocol;
  rate?: number;
  resetStats: boolean;
  name?: string;
  json: boolean;
};

export type RunStats = {
  tps: number;
  tx: number;
  failedTx: number;
  skippedTx: number;
  latMeanUs: number;
  latStddevUs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  maxUs: number;
};

export type BenchResult = {
  id: number;
  row: Omit<BenchRunRow, "id">;
  runs: RunStats[];
  tpsSpreadPct: number;
};

export type GucMap = Record<string, string>;
export type GucDiff = { name: string; from: string | null; to: string | null };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)

/**
 * Parse a pgbench -l per-transaction log. Field 3 (`time`) is the transaction
 * elapsed time in MICROSECONDS; it is the literal string "skipped" (rate mode,
 * late before start), "failed", or "serialization"/"deadlock"
 * (--failures-detailed) for non-completed transactions. Extra trailing columns
 * (schedule_lag, retries) are ignored. Multi-worker runs produce several log
 * files - concatenate them before parsing.
 */
export function parsePgbenchLog(text: string): {
  latenciesUs: number[];
  failedTx: number;
  skippedTx: number;
} {
  const latenciesUs: number[] = [];
  let failedTx = 0;
  let skippedTx = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const fields = t.split(/\s+/);
    const time = fields[2];
    if (time === undefined) continue;
    if (time === "skipped") {
      skippedTx++;
      continue;
    }
    if (time === "failed" || time === "serialization" || time === "deadlock") {
      failedTx++;
      continue;
    }
    const us = Number(time);
    if (Number.isFinite(us)) latenciesUs.push(us);
  }
  return { latenciesUs, failedTx, skippedTx };
}

/** Extract tps + failed count from pgbench's stdout summary. */
export function parseStdoutSummary(text: string): { tps: number | null; failedTx: number | null } {
  const tps = /tps = ([\d.]+) \(without initial connection time\)/.exec(text);
  const failed = /number of failed transactions: (\d+)/.exec(text);
  return {
    tps: tps ? Number(tps[1]) : null,
    failedTx: failed ? Number(failed[1]) : null,
  };
}

/** Nearest-rank percentile over an ASC-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** (max - min) / median * 100 - the run-to-run stability signal. */
export function spreadPct(xs: number[]): number {
  if (xs.length < 2) return 0;
  const med = median(xs);
  if (med === 0) return 0;
  return ((Math.max(...xs) - Math.min(...xs)) / med) * 100;
}

function stddev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/** Diff two pg_settings snapshots: changed, added, removed. */
export function diffGucs(a: GucMap, b: GucMap): GucDiff[] {
  const out: GucDiff[] = [];
  for (const name of Object.keys(a)) {
    if (!(name in b)) out.push({ name, from: a[name]!, to: null });
    else if (a[name] !== b[name]) out.push({ name, from: a[name]!, to: b[name]! });
  }
  for (const name of Object.keys(b)) {
    if (!(name in a)) out.push({ name, from: null, to: b[name]! });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** sha256 (first 12 hex chars) of the script identity. */
export function scriptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Stats for one measured run from its parsed log + stdout summary. */
export function summarizeRun(
  latenciesUs: number[],
  failedTx: number,
  skippedTx: number,
  tps: number | null,
  timeS: number,
): RunStats {
  const sorted = [...latenciesUs].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return {
    tps: tps ?? (timeS > 0 ? sorted.length / timeS : 0),
    tx: sorted.length,
    failedTx,
    skippedTx,
    latMeanUs: mean,
    latStddevUs: stddev(sorted, mean),
    p50Us: percentile(sorted, 50),
    p95Us: percentile(sorted, 95),
    p99Us: percentile(sorted, 99),
    maxUs: sorted.length ? sorted[sorted.length - 1]! : 0,
  };
}

// ---------------------------------------------------------------------------
// Rendering (pure, unit-tested)

const usToMs = (us: number) => `${(us / 1000).toFixed(1)}ms`;

export function renderRunLine(i: number, s: RunStats): string {
  return (
    `run ${i + 1}: tps ${s.tps.toFixed(1)}  p50 ${usToMs(s.p50Us)}  p95 ${usToMs(s.p95Us)}  ` +
    `p99 ${usToMs(s.p99Us)}  max ${usToMs(s.maxUs)}  failed ${s.failedTx}` +
    (s.skippedTx ? `  skipped ${s.skippedTx}` : "")
  );
}

export function renderBenchText(res: BenchResult): string {
  const lines = res.runs.map((r, i) => renderRunLine(i, r));
  const med = (f: (s: RunStats) => number) => median(res.runs.map(f));
  const spread = res.tpsSpreadPct;
  lines.push(
    `median: tps ${med((s) => s.tps).toFixed(1)}  p50 ${usToMs(med((s) => s.p50Us))}  ` +
      `p95 ${usToMs(med((s) => s.p95Us))}  p99 ${usToMs(med((s) => s.p99Us))}  ` +
      `(spread ${spread.toFixed(1)}% - ${spread > 15 ? "UNSTABLE, repeat before trusting" : "stable"})`,
  );
  if (res.row.tainted)
    lines.push(
      `WARNING: client load peaked at ${res.row.client_load_max.toFixed(1)} on ${res.row.client_cores} cores - the CLIENT may have bottlenecked; results tainted`,
    );
  lines.push(
    `stored as run #${res.id} (ref ${res.row.ref}, script ${res.row.script_hash}, ${res.runs.length} run${res.runs.length === 1 ? "" : "s"})`,
  );
  return lines.join("\n");
}

export function renderListText(rows: BenchRunRow[]): string {
  if (!rows.length) return "no bench runs stored";
  const lines = [
    "id   date                 ref                  script        scale  clients  time   tps      p95      p99      flags      name",
  ];
  for (const r of rows) {
    const flags = [r.tainted ? "tainted" : "", r.unstable ? "unstable" : ""]
      .filter(Boolean)
      .join(",");
    lines.push(
      `${String(r.id).padEnd(4)} ${new Date(r.ts * 1000).toISOString().slice(0, 19)}  ${r.ref.padEnd(20)} ${r.script_hash.padEnd(12)} ${String(r.scale).padEnd(6)} ${String(r.clients).padEnd(8)} ${`${r.time_s}s`.padEnd(6)} ${r.tps_median.toFixed(1).padEnd(8)} ${usToMs(r.p95_us).padEnd(8)} ${usToMs(r.p99_us).padEnd(8)} ${flags.padEnd(10)} ${r.name ?? ""}`,
    );
  }
  return lines.join("\n");
}

export function renderShowText(r: BenchRunRow): string {
  const lines = [
    `run #${r.id}  ${new Date(r.ts * 1000).toISOString()}`,
    `ref ${r.ref}  script ${r.script_hash}${r.name ? `  name "${r.name}"` : ""}`,
    `scale ${r.scale}  clients ${r.clients}  threads ${r.threads}  time ${r.time_s}s  protocol ${r.protocol}${r.rate ? `  rate ${r.rate}` : ""}`,
    `tps median ${r.tps_median.toFixed(1)}  p50 ${usToMs(r.p50_us)}  p95 ${usToMs(r.p95_us)}  p99 ${usToMs(r.p99_us)}  failed ${r.failed_tx}`,
    `client ${r.client_cores} cores, load max ${r.client_load_max.toFixed(1)}${r.tainted ? "  TAINTED (client saturation)" : ""}${r.unstable ? "  UNSTABLE (tps spread >15%)" : ""}`,
    `pgbench ${r.pgbench_version}  server ${r.server_version}`,
  ];
  const runs = JSON.parse(r.runs_json) as RunStats[];
  for (const [i, s] of runs.entries()) lines.push(`  ${renderRunLine(i, s)}`);
  lines.push(`pg_settings captured: ${r.guc ? Object.keys(r.guc).length : 0}`);
  return lines.join("\n");
}

const delta = (a: number, b: number) => (a === 0 ? "n/a" : `${(((b - a) / a) * 100).toFixed(1)}%`);

export function renderCompareText(a: BenchRunRow, b: BenchRunRow): string {
  const label = (r: BenchRunRow) =>
    `#${r.id} (${new Date(r.ts * 1000).toISOString().slice(0, 19)}${r.name ? `, ${r.name}` : ""})`;
  const lines = [
    `A ${label(a)}`,
    `B ${label(b)}`,
    `tps   ${a.tps_median.toFixed(1)} -> ${b.tps_median.toFixed(1)}  (${delta(a.tps_median, b.tps_median)})`,
  ];
  const lat = (name: string, fa: number, fb: number) =>
    lines.push(
      `${name.padEnd(5)} ${usToMs(fa)} -> ${usToMs(fb)}  (${delta(fa, fb)} - lower is better)`,
    );
  lat("p50", a.p50_us, b.p50_us);
  lat("p95", a.p95_us, b.p95_us);
  lat("p99", a.p99_us, b.p99_us);
  lines.push(`failed ${a.failed_tx} -> ${b.failed_tx}`);
  const gucs = diffGucs(a.guc ?? {}, b.guc ?? {});
  if (gucs.length) {
    lines.push("GUC changes A -> B:");
    for (const g of gucs) lines.push(`  ${g.name}: ${g.from ?? "(unset)"} -> ${g.to ?? "(unset)"}`);
  } else {
    lines.push("GUC changes A -> B: none recorded");
  }
  if (a.script_hash !== b.script_hash)
    lines.push(
      `WARNING: script differs between runs (${a.script_hash} vs ${b.script_hash}) - not the same workload`,
    );
  if (a.tainted || b.tainted)
    lines.push("WARNING: at least one run is tainted (client saturation) - compare with care");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration (live pgbench; exercised manually, not in CI)

/** pgbench binary: SBPERF_PGBENCH env, then PATH. Null when absent. */
export function findPgbench(): string | null {
  const env = process.env.SBPERF_PGBENCH;
  if (env) return env;
  return Bun.which("pgbench");
}

type ConnParts = { host: string; port: string; user: string; password: string; db: string };

/** Split a postgres:// connstring into pgbench -h/-p/-U/-d parts + password. */
export function parseConnstring(dbUrl: string): ConnParts {
  const u = new URL(dbUrl);
  return {
    host: u.hostname,
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    db: u.pathname.replace(/^\//, "") || "postgres",
  };
}

async function pgbenchVersion(bin: string): Promise<string> {
  const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return /pgbench \(PostgreSQL\) (\S+)/.exec(out)?.[1] ?? "unknown";
}

type SpawnResult = { code: number; stdout: string; stderr: string };

async function spawnPgbench(
  bin: string,
  conn: ConnParts,
  args: string[],
  onTick?: () => number,
): Promise<SpawnResult & { loadMax: number }> {
  let loadMax = 0;
  const timer = setInterval(() => {
    const l = onTick?.() ?? 0;
    if (l > loadMax) loadMax = l;
  }, 2000);
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: conn.password },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr, loadMax };
  } finally {
    clearInterval(timer);
  }
}

/** pg_settings as a human-readable name -> setting map (current_setting form). */
async function captureGucs(runner: DirectSqlRunner): Promise<GucMap | null> {
  try {
    const rows = await runner.run("SELECT name, current_setting(name) AS setting FROM pg_settings");
    const map: GucMap = {};
    for (const r of rows) map[String(r.name)] = String(r.setting);
    return map;
  } catch (err) {
    console.error(
      `> warning: pg_settings capture failed (${err instanceof Error ? err.message : err})`,
    );
    return null;
  }
}

/**
 * Run the benchmark: preflight guardrails -> optional init -> warmup -> N
 * measured runs with per-transaction logging -> aggregate + store. Returns the
 * stored run id + stats; rendering is renderBenchText's job.
 */
export async function runBench(opts: BenchOptions, store: HistoryStore): Promise<BenchResult> {
  const bin = findPgbench();
  if (!bin)
    throw new Error(
      "pgbench not found. Install PostgreSQL client tools, or set SBPERF_PGBENCH=/path/to/pgbench",
    );
  const cores = cpus().length;
  const load1 = loadavg()[0] ?? 0;
  if (load1 > 0.5 * cores && !opts.yes)
    throw new Error(
      `client load is ${load1.toFixed(1)} on ${cores} cores - a busy client benchmarks itself, not the database. Quiet the machine or re-run with --yes to proceed anyway.`,
    );

  const threads = Math.min(opts.threads ?? Math.min(cores, opts.clients), opts.clients);
  if (opts.timeS < 30)
    console.error(`> warning: --time ${opts.timeS}s is short; warmup dominates runs under ~30s`);
  if (opts.runs < 2)
    console.error(
      "> warning: a single measured run cannot detect instability (--runs 3 recommended)",
    );

  const conn = parseConnstring(opts.dbUrl);
  const version = await pgbenchVersion(bin);
  console.error(`> pgbench ${version} -> ${conn.host}:${conn.port}/${conn.db} (as ${conn.user})`);
  console.error(
    `> ${opts.clients} clients / ${threads} threads, ${opts.runs} x ${opts.timeS}s${opts.warmupS ? ` + ${opts.warmupS}s warmup` : ""}, protocol ${opts.protocol}${opts.rate ? `, rate ${opts.rate} tps` : ""}`,
  );

  if (opts.init) {
    if (!opts.yes)
      throw new Error(
        "--init DROPS and recreates the pgbench_* tables in the target database. Re-run with --yes to confirm.",
      );
    console.error(
      `> initializing pgbench tables at scale ${opts.scale} (drops existing pgbench_*)`,
    );
    const r = await spawnPgbench(bin, conn, ["-i", "-s", String(opts.scale), ...connArgs(conn)]);
    if (r.code !== 0)
      throw new Error(`pgbench -i failed (exit ${r.code}): ${r.stderr.slice(0, 300)}`);
  }

  const runner = new DirectSqlRunner(opts.dbUrl);
  try {
    let serverVersion = "unknown";
    try {
      const rows = await runner.run("SHOW server_version");
      serverVersion = String(rows[0]?.server_version ?? "unknown");
    } catch {
      // non-fatal: version is stored for provenance only
    }

    if (opts.resetStats) {
      try {
        await runner.run("SELECT pg_stat_statements_reset() AS reset");
        console.error("> pg_stat_statements reset (benchmark window starts clean)");
      } catch (err) {
        console.error(
          `> warning: --reset-stats failed (${err instanceof Error ? err.message : err}); needs superuser + pg_stat_statements - continuing unreset`,
        );
      }
    }

    const gucBefore = await captureGucs(runner);

    const scriptArgs: string[] = [];
    if (opts.scripts.length) {
      for (const f of opts.scripts) scriptArgs.push("-f", f);
      scriptArgs.push("-n"); // custom scripts: skip the standard-table vacuum
    } else {
      scriptArgs.push("-b", opts.builtin);
    }

    const dir = await mkdtemp(join(tmpdir(), "sbperf-bench-"));
    const runs: RunStats[] = [];
    let loadMax = 0;
    try {
      if (opts.warmupS > 0) {
        console.error(`> warmup: ${opts.warmupS}s (unmeasured)`);
        const w = await spawnPgbench(bin, conn, [
          ...connArgs(conn),
          ...scriptArgs,
          "-c",
          String(opts.clients),
          "-j",
          String(threads),
          "-T",
          String(opts.warmupS),
          "--protocol",
          opts.protocol,
        ]);
        if (w.code !== 0)
          throw new Error(`warmup failed (exit ${w.code}): ${w.stderr.slice(0, 300)}`);
      }

      for (let i = 0; i < opts.runs; i++) {
        console.error(`> run ${i + 1}/${opts.runs}: ${opts.timeS}s (measured, logged)`);
        const prefix = join(dir, `run${i + 1}`);
        const rateArgs = opts.rate ? ["--rate", String(opts.rate)] : [];
        const r = await spawnPgbench(
          bin,
          conn,
          [
            ...connArgs(conn),
            ...scriptArgs,
            "-c",
            String(opts.clients),
            "-j",
            String(threads),
            "-T",
            String(opts.timeS),
            "-s",
            String(opts.scale),
            "--protocol",
            opts.protocol,
            "-l",
            "--log-prefix",
            prefix,
            ...rateArgs,
          ],
          () => loadavg()[0] ?? 0,
        );
        if (r.loadMax > loadMax) loadMax = r.loadMax;
        if (r.code !== 0)
          throw new Error(
            `pgbench run ${i + 1} failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`,
          );
        const summary = parseStdoutSummary(r.stdout);
        let logText = "";
        const glob = new Bun.Glob(`${prefix.split("/").pop()}*`);
        for await (const f of glob.scan({ cwd: dir, absolute: true })) {
          logText += `${await Bun.file(f).text()}\n`;
        }
        if (!logText.trim())
          throw new Error(`no pgbench log files matched ${prefix}* - cannot compute percentiles`);
        const parsed = parsePgbenchLog(logText);
        runs.push(
          summarizeRun(
            parsed.latenciesUs,
            parsed.failedTx || (summary.failedTx ?? 0),
            parsed.skippedTx,
            summary.tps,
            opts.timeS,
          ),
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const gucAfter = (await captureGucs(runner)) ?? gucBefore;

    const scriptText = opts.scripts.length
      ? (
          await Promise.all(
            opts.scripts.map(async (f) => `-- file: ${f}\n${await Bun.file(f).text()}`),
          )
        ).join("\n")
      : null;
    const hash = scriptText ? scriptHash(scriptText) : `builtin:${opts.builtin}`;

    const tpsSpread = spreadPct(runs.map((r) => r.tps));
    const input: BenchRunInput = {
      ref: opts.ref,
      ts: Math.floor(Date.now() / 1000),
      name: opts.name ?? null,
      script_hash: hash,
      script_text: scriptText,
      scale: opts.scale,
      clients: opts.clients,
      threads,
      time_s: opts.timeS,
      protocol: opts.protocol,
      rate: opts.rate ?? null,
      runs_json: JSON.stringify(runs),
      tps_median: median(runs.map((r) => r.tps)),
      p50_us: Math.round(median(runs.map((r) => r.p50Us))),
      p95_us: Math.round(median(runs.map((r) => r.p95Us))),
      p99_us: Math.round(median(runs.map((r) => r.p99Us))),
      failed_tx: runs.reduce((n, r) => n + r.failedTx, 0),
      guc_json: gucAfter ? JSON.stringify(gucAfter) : null,
      client_cores: cores,
      client_load_max: loadMax,
      tainted: loadMax > cores,
      unstable: tpsSpread > 15,
      pgbench_version: version,
      server_version: serverVersion,
    };
    const id = store.recordBenchRun(input);
    const { guc_json: _gucJson, ...rest } = input;
    const row: Omit<BenchRunRow, "id"> = { ...rest, guc: gucAfter };
    return { id, row, runs, tpsSpreadPct: tpsSpread };
  } finally {
    await runner.close();
  }
}

function connArgs(conn: ConnParts): string[] {
  return ["-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.db];
}
