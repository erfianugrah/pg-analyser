# pgbench tutorial

A simple tool for testing query performance and, more often, optimizing Postgres
configs. This is the verification companion to pg-analyser: a finding tells you *what*
to fix, pgbench is how you *prove* the fix worked under concurrency.

Content verified empirically (2026-07) with pgbench 18.4 against Postgres 17.6
and against a Supavisor transaction-mode pooler. Reference:
https://www.postgresql.org/docs/current/pgbench.html

## Safety first

- `pgbench -i` **drops and recreates** any tables named `pgbench_*` and writes
  them into the `public` schema. Run it against a throwaway project or a
  Supabase branch, never against a project you care about.
- The custom-script example below bulk-inserts into `auth.users`. That bypasses
  GoTrue and writes to a Supabase-managed schema - fine on a disposable project,
  unacceptable anywhere else. Prefer your own test table when in doubt.
- pgbench hammers the database by design. On a small Supabase compute size a
  high `-c` will saturate CPU/connections; start small (`-c 4`) and scale up.
  On shared or small compute this cuts both ways: your run degrades co-tenants
  (noisy neighbor), and their load taints your numbers. Pick a quiet window
  and expect results on shared infrastructure to be noisier.

> **Shortcut:** `pg-analyser bench --db-url <c>` wraps pgbench and enforces the
> mechanizable half of this doc by construction (client-saturation checks,
> warmup + repetition with spread detection, exact p50/p95/p99 from the `-l`
> log, a pg_settings snapshot per run, run history + `--compare`). The manual
> flags below are still the reference for what it does and why.

## What pgbench can and cannot tell you

Read this before drawing conclusions from any number pgbench prints.

- **The built-in suite is an obsolete benchmark.** The default tpcb-like
  script is based on TPC-B, which the TPC itself declared obsolete in 1995.
  Treat built-in-suite numbers as an infra/software comparison only: same
  software on different hardware, or different software versions on the same
  hardware. Do not infer anything about *your* workload from tpcb-like TPS.
- **There is no better benchmark than your own.** Representative means your
  schema, your queries, your concurrency profile - i.e. custom `-f` scripts
  against a copy of your data shape. That is why the worked example below
  matters more than the built-in suite.
- **The client machine is part of the benchmark.** Run pgbench in the same
  region as the database, on a quiet machine with enough cores (`-j` threads)
  and no competing workload. A multi-tasking or resource-starved client
  bottlenecks before the database does, and every number from that point on is
  fiction. Comparing your laptop against a managed database flatters the
  laptop: direct access, no network latency, no shared I/O. Compare like with
  like.
- **Change one variable at a time.** Two changes between runs and you no
  longer know what moved the number.

## Connecting to Supabase

| Endpoint | Host | Port | Notes |
|---|---|---|---|
| Direct | `db.<ref>.supabase.co` | 5432 | IPv6-only unless the IPv4 add-on is enabled |
| Pooler, session mode | `aws-N-<region>.pooler.supabase.com` | 6543 | behaves like a direct connection |
| Pooler, transaction mode | `aws-N-<region>.pooler.supabase.com` | 5432 | use extended protocol; prepared also works (verified) |

Optional: set environment variables to avoid repeating connection flags.
pgbench reads the standard libpq vars:

```bash
export PGHOST=<host>
export PGPORT=<port>
export PGPASSWORD=<password>
export PGDATABASE=postgres
export PGUSER=postgres
```

`env | grep PG` shows what is set.

## Default test suite

pgbench ships with built-in tests loosely based on the TPC-B benchmark from the
Transaction Processing Performance Council (https://www.tpc.org/default5.asp).

Initialization builds and populates 4 tables (all in `public`):

- `pgbench_accounts` - `aid integer NOT NULL PRIMARY KEY, bid integer, abalance integer, filler character(84)`, `fillfactor=100`
- `pgbench_branches` - `bid integer NOT NULL PRIMARY KEY, bbalance integer, filler character(88)`, `fillfactor=100`
- `pgbench_history` - `tid, bid, aid, delta integer, mtime timestamp, filler character(22)` - no PK, no indexes, no fillfactor
- `pgbench_tellers` - `tid integer NOT NULL PRIMARY KEY, bid integer, tbalance integer, filler character(84)`, `fillfactor=100`

For each transaction it generates a random `aid` (account), `tid` (teller),
`bid` (branch) and `delta` (balance change), then runs one of the built-in
scripts on repeat:

- **tpcb-like (default)** - update account, read balance, update teller, update branch, insert history (5 statements in one transaction)
- **simple-update** - update account, read balance, insert history (3 statements)
- **select-only** - read balance (1 statement)

```sql
-- tpcb-like
BEGIN;
    UPDATE pgbench_accounts SET abalance = abalance + :delta WHERE aid = :aid;
    SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
    UPDATE pgbench_tellers SET tbalance = tbalance + :delta WHERE tid = :tid;
    UPDATE pgbench_branches SET bbalance = bbalance + :delta WHERE bid = :bid;
    INSERT INTO pgbench_history (tid, bid, aid, delta, mtime) VALUES (:tid, :bid, :aid, :delta, CURRENT_TIMESTAMP);
END;
```

### Scale factor - the number everyone gets wrong

`pgbench_accounts` holds **100,000 rows x scale factor**, not 10,000.
Verified: scale 1 -> 100,000 rows, scale 10 -> 1,000,000 rows. Branches scale
as 1 x scale, tellers as 10 x scale, history starts empty. Pick a scale whose
working set matches what you want to test (fits-in-cache vs disk-bound).

## Step 1: create the default tables

```bash
pgbench -h db.<ref>.supabase.co -U postgres -d postgres -p 5432 -i
```

`-i` is shorthand for init steps `dtgvp`:

1. **d** - drop the test tables if they exist
2. **t** - create the tables
3. **g** - generate data client-side and send it with `COPY`
   (`G` instead generates the data server-side: more load on Postgres, less
   bandwidth; no progress messages)
4. **v** - vacuum the tables
5. **p** - create primary keys
6. **f** - (optional) create foreign keys between the tables

Init works through the Supavisor **transaction-mode pooler** too - verified
2026-07: full `-i` (DDL + COPY + VACUUM + primary keys) succeeded against the
pooler on :5432. One caveat for large scales: the default `statement_timeout`
on Supabase can kill a big data-generation step; raise it for the session or
use `-I dtg` + `G` (server-side generation) and init in stages.

Run a subset or reorder with `-I`, e.g. `-I dtgvpf`. Other init flags:

- `-s N` - scale factor (default 1 = 100k account rows)
- `-n` / `--no-vacuum` - skip vacuum even if `v` is in the steps
- `-q` / `--quiet` - progress every 5s instead of every 100k rows
- `--foreign-keys` - same as the `f` init step
- `--unlogged-tables` - create the tables UNLOGGED (faster writes, not crash-safe)
- `--fillfactor=N` - default 100; lower values leave room for HOT updates

```bash
pgbench -h <host> -U postgres -d postgres -p 5432 \
    -i -n -s 10 --foreign-keys --unlogged-tables
```

## Step 2: run the test

```bash
pgbench -h <host> -U postgres -d postgres -p 5432
```

With no flags this runs the tpcb-like script, 1 client, 10 transactions. See
"Configuring pgbench" below for the useful flags.

## Step 3: interpreting results

Modern output looks like this:

```
pgbench (18.4, server 17.6)
transaction type: <builtin: select only>
scaling factor: 2
query mode: simple
number of clients: 20
number of threads: 16
maximum number of tries: 1
number of transactions per client: 10
number of transactions actually processed: 200/200
number of failed transactions: 0 (0.000%)
latency average = 126.935 ms
latency stddev = 12.345 ms
initial connection time = 1895.383 ms
tps = 157.561081 (without initial connection time)
```

| Line | Meaning |
|---|---|
| transaction type | builtin vs custom script file |
| scaling factor | rows in `pgbench_accounts` / 100,000 |
| query mode | simple / extended / prepared protocol |
| number of clients | concurrent database connections (`-c`) |
| number of threads | pgbench worker threads (`-j`) |
| maximum number of tries | retry cap for serialization/deadlock failures (`--max-tries`, default 1 = no retries) |
| transactions per client | how many transactions each client runs (`-t`, default 10; absent in `-T` duration mode) |
| actually processed | attempted/succeeded; equal unless the run failed or SQL errored |
| failed transactions | serialization/deadlock failures (0.000% here) |
| latency average | mean time per transaction, client-side. NOT the same as EXPLAIN - it includes network round-trips and pooler queuing |
| latency stddev | spread of per-transaction latency (newer pgbench only; watch this, not just the mean) |
| initial connection time | time to establish all connections up front. Front-loaded when going through Supavisor; use `-C` to measure per-transaction connect overhead instead |
| tps | transactions per second, excluding initial connection time |

## Configuring pgbench

### Selecting scripts

- `-b scriptname[@weight]` - pick builtin scripts (`tpcb-like`, `simple-update`,
  `select-only`); repeat with weights to mix them
- `-S` - shorthand for the select-only builtin
- `--show-script=scriptname` - print the builtin's code and exit
- `-f filename[@weight]` - add a custom script file (repeatable, weighted)
- `-n` - no pre-run vacuum. **Required** for custom scripts on non-pgbench
  tables (pgbench would otherwise try to vacuum the standard tables)
- `-D varname=value` - define a variable usable in scripts as `:varname`
- `-v` - vacuum all four standard tables before running. With neither `-n` nor
  `-v`, pgbench vacuums tellers+branches and truncates history

### Connections

- `-c N` - concurrent client connections (default 1)
- `-j N` - pgbench worker threads; use on multi-core machines (default 1)
- `-C` / `--connect` - open a fresh connection per transaction. The flag for
  measuring connection overhead (interesting against Supavisor)
- `--protocol=simple|extended|prepared` - query protocol:
  - `simple` - default, no parse/bind split
  - `extended` - parse/bind/execute; the safe choice through pgbouncer/Supavisor
  - `prepared` - extended + named prepared statements; reuses parse analysis
    from the second iteration so it is fastest. Historically broken through
    transaction-mode poolers; verified working through Supavisor transaction
    mode (2026-07, 0 failed transactions). If in doubt, use `extended`

### Duration

- `-T seconds` - run for a fixed time (mutually exclusive with `-t`)
- `-t N` - transactions per client (default 10; mutually exclusive with `-T`)

For stable numbers use `-T 60` or more. Short runs are dominated by warmup.

### Rate limiting and slow transactions

- `-R rate` - target TPS instead of maximum speed (Poisson-scheduled). The way
  to test "can the DB keep up with load X" rather than "how fast can it go"
- `-L ms` / `--latency-limit=ms` - transactions lasting longer than this are
  counted and reported as late. With `-R`, transactions that arrive past the
  limit are skipped instead of sent
- `--max-tries=N` - retries for serialization/deadlock errors (default 1 = no
  retries; 0 = unlimited, requires `-L` or `-T`)

### Debugging

- `-d` - debug output
- `--verbose-errors` - print all errors and failures
- `--failures-detailed` - per-transaction-type breakdown of serialization vs
  deadlock failures
- `--random-seed=seed` - reproduce a run exactly (per-thread, single client per
  thread). Great for debugging, bad for benchmarks: re-hitting the same pages
  skews results

### Logging

- `-l` - write per-transaction log lines to a file
- `--log-prefix=prefix` - log file prefix (default `pgbench_log`, not
  `pgbench.log`)
- `--sampling-rate=rate` - fraction of transactions to log
- `-r` - per-command stats after the run: average statement latency, failures,
  retries

### Progress

- `-P sec` - progress report every N seconds: tps, latency, stddev, failures
  since last report
- `--progress-timestamp` - Unix epoch timestamps instead of elapsed seconds
  (easier to correlate with Grafana / metrics)

## Custom script worked example: LIKE vs ILIKE

A realistic A/B: does `ILIKE` cost more than `LIKE` on a lookup query? Two
script files, one operator each, run against a million-row table.

> Local activity (browser, video, other terminals) distorts pgbench. Minimize
> background tasks, and prefer running pgbench from a VM near the database.

1. Create the scripts. The `DO` block + `PERFORM` pattern lets you randomize
   the search term per transaction without returning rows to the client:

```sql
-- like.sql (ilike.sql is identical with ILIKE)
DO $$
DECLARE
    email_var TEXT = concat('%user', floor(random() * 1000000), '@example.com%');
BEGIN
  PERFORM * FROM bench_users
  WHERE (id::text LIKE email_var OR email LIKE email_var OR phone LIKE email_var)
  ORDER BY created_at DESC NULLS LAST
  LIMIT 50;
END $$;
```

2. Populate a test table. On a disposable project you can use `auth.users` as
   the original example does (a `DO` loop of 1M INSERTs with
   `concat('user', i, '@example.com')` emails and randomized timestamps) - but
   a table you own in `public` is strictly safer and tests the same thing.

3. Run each variant:

```bash
pgbench -f ./like.sql -n -c 1 -T 60
```

   (`-T 500` as in the original example means an 8+ minute run - fine for final
   numbers, tedious while iterating. Start with 30-60s.)

4. Between runs, reset the cache baseline if you want cold-cache numbers:

```sql
TRUNCATE bench_users;            -- or your test table
-- repopulate
VACUUM ANALYZE bench_users;
```

   Skipping this is also legitimate - just be consistent, and note that warm
   cache flatters both variants. Long runs (30+ min) average cache effects out.

5. Compare. Real numbers from the original experiment (500s runs, 1 client):

| variant | tps | latency avg |
|---|---|---|
| LIKE | 2.48 | 402.9 ms |
| ILIKE | 0.67 | 1502.0 ms |

   ILIKE was ~3.7x slower here - the kind of result that justifies an index or
   a `lower(email)` functional index, which you can then verify with the same
   two scripts.

## Tuning workflow: where pgbench fits

The productive use of pgbench is config validation, not config discovery:

1. Start from a sane baseline for the instance size (PGTune is the usual
   starting point for `shared_buffers`, `work_mem`, `max_connections`).
2. Change ONE GUC.
3. Benchmark with the same script, same scale, same duration, same seed if you
   must reproduce exactly.
4. Keep or revert, then iterate.

Prefer scoped GUC changes over system-wide ones while experimenting:
`ALTER ROLE ... SET work_mem = '64MB'` or `ALTER DATABASE ... SET ...` (or a
session-level `SET` inside the pgbench script itself) is reversible and has no
blast radius; `ALTER SYSTEM` touches every connection. Many Supabase GUCs are
settable per role/database - pg-analyser's config-tuning findings flag the ones
worth looking at (work_mem blast radius, timeouts, checkpoint completion).

## Beyond the basics (what most pgbench tutorials miss)

### Scripting: meta-commands and skewed randomness

Custom scripts are not just SQL. pgbench adds backslash meta-commands and a
function library:

- `\set name expression` - compute a variable, e.g.
  `\set aid random(1, 100000 * :scale)`
- `\sleep N ms` - think time between statements (realistic user pacing)
- `\if` / `\elif` / `\else` / `\endif` - conditional script paths
- `random_gaussian(lb, ub, param)`, `random_zipfian(lb, ub, param)`,
  `random_exponential(lb, ub, param)` - skewed distributions. The default
  `random()` is uniform, which no real workload is. A Zipfian `aid` simulates
  hot-row contention (a few accounts taking most updates) - the difference
  between "benchmark says fine" and the lock queue you get in production
- `permute(i, size[, seed])` - scatter a skewed distribution so hot values
  are not trivially correlated with low ids

### Pipelining

`\startpipeline` ... `\endpipeline` (with optional `\syncpipeline` inside)
sends statements without waiting for each result - measures Postgres pipeline
mode, a real optimization lever for chatty transactions. Requires the extended
query protocol (`--protocol=extended`).

### Percentiles: the summary hides the tail

(`pg-analyser bench` does this for you - every measured run logs per-transaction
data and reports p50/p95/p99. This is the manual equivalent.)

The stdout report gives mean and stddev only - no p95/p99. For tail latency,
log per-transaction data and compute percentiles from the log:

```bash
pgbench -l --log-prefix=bench -T 60 ...
# one file per worker thread: bench_log.<pid>[.N]
# fields: client_id transaction_no time script_no time_epoch time_us [retries]
awk '{print $3}' bench_log.* | sort -n | awk '{a[NR]=$1} END {print "p50",a[int(NR*0.5)],"p95",a[int(NR*0.95)],"p99",a[int(NR*0.99)]}'
```

`--aggregate-interval=N` switches the log to per-interval summaries (interval,
transactions, sum/min/max latency, failures) - cheaper on long high-TPS runs and
directly plottable.

### Exit codes and CI

- 0 = success; 1 = bad options / could not connect; 2 = errors during the run
  (partial results printed)
- `--exit-on-abort` - stop everything on the first client abort instead of
  printing partial results. What you want in a CI gate: a benchmark that
  silently limps to completion with dead clients is worse than a loud failure

### Bracketing a benchmark with pg-analyser

The verification loop this doc exists for:

1. `pg-analyser snapshot --ref <ref>` - baseline into the history store
2. Run the pgbench workload
3. Apply the fix (index, config, query rewrite)
4. Run the same workload again
5. `pg-analyser snapshot --ref <ref>` then `pg-analyser diff --ref <ref>` - per-query
   regressions matched by `queryid` (>=1.5x mean exec time = regression), so
   you see the fix land in pg_stat_statements, not just in pgbench TPS

With a superuser connstring you can also `pg_stat_statements_reset()` right
before the run so the window contains only the benchmark (pg-analyser never resets
it itself - do it via your own SQL session).

## See also

- Official docs: https://www.postgresql.org/docs/current/pgbench.html
- Fillfactor explainer: https://www.cybertec-postgresql.com/en/what-is-fillfactor-and-how-does-it-affect-postgresql-performance/
- pg-analyser `heuristics.md` - the thresholds whose fixes this verifies
