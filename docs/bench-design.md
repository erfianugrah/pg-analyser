# pg-analyser bench - design note

A pgbench wrapper with methodology guardrails. The doc (`docs/pgbench.md`)
carries the *why* (disclaimers, representativeness); `bench` enforces the
*how* (the mechanizable flaws): client-side saturation, too-short runs, no
tail latency, untracked config changes, and result amnesia.

pgbench does the actual work. pg-analyser adds preflight checks, repetition with
stability detection, percentile parsing, GUC diffing between runs, and a
SQLite run history keyed by (ref, script) so "did work_mem=64MB help?" is a
query, not a memory.

## Command surface

```
pg-analyser bench --db-url <c> [-f script.sql ...] [-b tpcb-like] [options]   # run
pg-analyser bench --list [--ref <r>]                                          # history
pg-analyser bench --show <id>                                                 # one run
pg-analyser bench --compare <idA> <idB>                                       # delta
```

Run options:

| Flag | Default | Notes |
|---|---|---|
| `-f <file>` (repeatable) | - | custom script(s); weights as `file@N` |
| `-b <name>` | tpcb-like | builtin script (ignored when -f given) |
| `--scale N` | 1 | init scale / reported scale |
| `--init` | off | run `pgbench -i` first; prints the drop warning, needs `--yes` |
| `--clients N` | 4 | `-c` |
| `--threads N` | min(cores, clients) | `-j`; capped at clients |
| `--time S` | 60 | measured duration per run; <30 warns |
| `--warmup S` | 10 | unmeasured warmup run before the first measured run |
| `--runs N` | 3 | measured repetitions; median reported, spread checked |
| `--protocol` | extended | simple / extended / prepared |
| `--rate N` | off | `-R` target TPS (load-test mode instead of max-speed) |
| `--reset-stats` | off | `pg_stat_statements_reset()` before measuring (superuser only) |
| `--name <label>` | - | free-text label stored with the run |
| `--json` | off | machine-readable stdout |
| `--yes` | off | skip interactive confirmations (--init) |

`--db-url` resolution reuses the existing sweep-target chain (flag / env /
pg-analyser.databases.json / profile). bench is inherently no-PAT: pgbench speaks
the wire protocol, so a connstring is required and no Management API planes
are touched.

## Guardrails (preflight, in order)

1. **Binary**: pgbench found via `PG_ANALYSER_PGBENCH` env, then PATH
   (`findPgbench()`, same discovery shape as `findChrome()` in report/pdf.ts).
   Version parsed from `pgbench --version` and stored with the run.
2. **Client saturation**: `os.cpus()` + `os.loadavg()`. Abort (unless `--yes`)
   when load1 > 0.5 x cores before the run: a busy client benchmarks itself.
   During the run, sample loadavg every 2s; mark the run `tainted` when load1
   exceeds cores - the client may have bottlenecked mid-run.
3. **Thread sanity**: `--threads` defaults to min(cores, clients) and is
   clamped to `--clients` (pgbench rejects threads > clients anyway).
4. **Duration floor**: `--time < 30` warns that warmup dominates; `--runs 1`
   warns that a single run cannot detect instability.
5. **Init confirmation**: `--init` prints "drops and recreates pgbench_* in
   the target database" and requires `--yes`.
6. **Reset-stats tier check**: `--reset-stats` runs through DirectSqlRunner;
   on a non-superuser connstring the error is caught and downgraded to a
   warning (run proceeds unreset).

## Measurement

- Every measured run executes with `-l` (per-transaction log) into a mkdtemp
  dir, parsed afterwards for exact percentiles - no reliance on pgbench's
  mean/stddev-only summary. Log format (space-separated):
  `client_id transaction_no time_us script_no time_epoch time_us [retries]`
- Per run: tps, lat_mean, lat_stddev, p50, p95, p99, max, failed_tx.
- Across `--runs N`: median of each stat + tps spread. Spread
  (max-min)/median > 15% marks the run set `unstable` - repeat before
  trusting it.
- **GUC capture**: before the first measured run and after the last, pull
  `pg_settings` (name, setting, unit, pending_restart) via DirectSqlRunner.
  Stored as JSON with the run; `--compare` diffs the two runs' GUC maps so the
  config delta sits next to the perf delta ("what changed" is never memory).
- `--reset-stats`: `SELECT pg_stat_statements_reset()` before the first
  measured run, so a follow-up `pg-analyser snapshot` + `diff` brackets exactly the
  benchmark window.

## Store schema (history.db, new table)

```sql
CREATE TABLE IF NOT EXISTS bench_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT NOT NULL,
  ts             INTEGER NOT NULL,          -- unix seconds
  name           TEXT,                      -- --name label
  script_hash    TEXT NOT NULL,             -- sha256 of script text, or 'builtin:<name>'
  script_text    TEXT,                      -- custom script source (null for builtins)
  scale          INTEGER NOT NULL,
  clients        INTEGER NOT NULL,
  threads        INTEGER NOT NULL,
  time_s         INTEGER NOT NULL,
  protocol       TEXT NOT NULL,
  rate           INTEGER,                   -- null = max speed
  runs_json      TEXT NOT NULL,             -- per-run stats array
  tps_median     REAL NOT NULL,
  p50_us         INTEGER NOT NULL,
  p95_us         INTEGER NOT NULL,
  p99_us         INTEGER NOT NULL,
  failed_tx      INTEGER NOT NULL,
  guc_json       TEXT,                      -- pg_settings map at run time
  client_cores   INTEGER NOT NULL,
  client_load_max REAL NOT NULL,
  tainted        INTEGER NOT NULL DEFAULT 0,
  unstable       INTEGER NOT NULL DEFAULT 0,
  pgbench_version TEXT NOT NULL,
  server_version  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_ref_script ON bench_runs(ref, script_hash, ts);
```

Same `~/.pg-analyser/history.db` as snapshots (one history file per user; the
table is independent, no FK to snapshots). HistoryStore grows:
`recordBenchRun()`, `benchRuns(ref, scriptHash?)`, `benchRun(id)`.
Connstrings are never stored - `ref` is derived via the existing
`refFromConnstring()`.

## Output

Text mode: preflight lines on stderr (logger conventions), result table on
stdout - one row per measured run plus a median row, ending with the stability
verdict and the store id:

```
run 1: tps 812.3  p50 4.1ms  p95 12.9ms  p99 31.2ms  failed 0
run 2: tps 805.1  p50 4.2ms  p95 13.1ms  p99 30.8ms  failed 0
run 3: tps 818.9  p50 4.0ms  p95 12.7ms  p99 29.9ms  failed 0
median: tps 812.3  p95 12.9ms  p99 30.8ms  (spread 1.7% - stable)
stored as run #7 (ref xyz, script sha256:1a2b3c, 3 runs)
```

`--compare A B`: side-by-side stat deltas (%) + the GUC diff between the two
runs, e.g. `work_mem: 4MB -> 64MB`, so the table reads as "changed X, p95
moved Y%".

## Non-goals (MVP)

- No TPC-C/hammerdb-style infra-comparison harness - a different tool class
  (throughput leaderboards), not the customer config-tuning loop.
- No automatic snapshot bracketing (`pg-analyser snapshot` before/after stays a
  manual step; may become `--bracket` later).
- No CI regression gate on `--compare` (a `--fail-if-slower-pct` is the
  natural phase 2, mirroring check.ts's evaluateGate).
- No client-region vs DB-region assertion.
- No server-side changes: bench never SETs a GUC, installs an extension, or
  resets stats unless explicitly asked (--reset-stats).

## Files

- `src/bench.ts` - orchestration + guardrails; pure helpers (log parser,
  percentiles, median/spread, guc diff) exported for tests
- `src/store.ts` - bench_runs table + 3 methods
- `src/index.ts` - `bench` case + parseFlags additions
- `test/bench.test.ts` - parser/percentile/spread/guc-diff units (fixture
  pgbench logs), store round-trip (:memory:), preflight logic with injected
  system info
- `docs/pgbench.md` - cross-link to the command once shipped
- README/AGENTS.md - command table entries

Live pgbench runs are NOT in CI (same stance as Chromium for PDF): unit
tests cover parsing/math/guardrails against fixtures; live verification is
manual against a throwaway Postgres.
