# sbperf

Supabase performance analysis, PAT-only. Pulls advisors, read-only SQL
diagnostics, project config, and infra metrics, and renders a self-contained
**HTML + PDF** report you can drag straight into an email or Slack.

One reproducible command produces the whole report from the Management API,
read-only SQL, and the project metrics endpoint - no superuser connection
string and no manual dashboard screenshots to assemble.

## Quick start

Needs [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
bun install
cp .env.example .env          # add SUPABASE_ACCESS_TOKEN
# PDF needs a system Chrome/Chromium on PATH (or set SBPERF_CHROME)

bun run src/index.ts full --ref <project-ref>
# -> reports/<ref>-<ts>/{analysis.json, report.html, report.pdf}
```

Your **project ref** is the 20-char id in the dashboard URL
(`supabase.com/dashboard/project/<ref>`) or from `supabase projects list`.
Run `sbperf --help` for the full command list.

Or step by step:

```bash
bun run src/index.ts analyze --ref <ref> --out ./reports/myproject
bun run src/index.ts report  ./reports/myproject    # report.html + summary.html
bun run src/index.ts summary ./reports/myproject    # non-technical summary.html only
bun run src/index.ts pdf     ./reports/myproject    # report.pdf + summary.pdf
bun run src/index.ts narrate ./reports/myproject    # narrative.md (optional LLM pass)
bun run src/index.ts import-trends ./reports/myproject series.csv  # merge external trends
```

`report`/`pdf` emit two documents: the full technical **report** and a
non-technical one-page **summary** (plain-language verdict for a non-engineering
audience).

## Install as a command (`sbperf`)

The examples above use `bun run src/index.ts ...` (the raw dev invocation). To
get a real `sbperf` command, pick one:

**Compiled binary** (no Bun at runtime, fastest startup - best for just using it):

```bash
bun run build              # -> ./sbperf (standalone, embeds the Bun runtime; gitignored)
mv sbperf ~/.local/bin/    # or anywhere on your PATH
sbperf full --ref <ref>    # works anywhere
```

Rebuild after code changes (`bun run build && mv sbperf ~/.local/bin/`).

**`bun link`** (tracks live source, no rebuild - best while developing):

```bash
bun link                   # uses the `bin` + shebang in package.json
sbperf full --ref <ref>    # runs current src/ instantly; needs Bun installed
```

Both give the same `sbperf <command>` UX; the rest of this README writes
`sbperf ...` interchangeably with `bun run src/index.ts ...`.

Audit every project in the account (writes an `index.html` linking them all):

```bash
bun run src/index.ts full --all [--org <slug>]
```

Audit a **specific subset** of projects into the same combined index (PAT-only,
no `--db-url`). `--ref` is repeatable and also accepts comma/space-delimited
lists; `--ref-file` reads refs from a `.txt` (one per line) or `.csv`:

```bash
bun run src/index.ts full --ref <ref1> --ref <ref2>     # repeat
bun run src/index.ts full --ref <ref1>,<ref2>,<ref3>    # comma (or space) list
bun run src/index.ts full --ref-file refs.txt           # one ref per line
bun run src/index.ts full --ref-file projects.csv       # any 20-char ref column
```

These write to `reports/refs-<ts>/` with the same org -> project grouping +
combined `index.html` as `--all`, scoped to just those refs (stack `--org` on
top to filter further). Lists + repeats + files combine and are deduped. A
`--ref-file` with headers/name/region columns is fine - any 20-lowercase-letter
token is picked up by shape and everything else is ignored; a file with content
but no ref fails loud. `snapshot` also takes multiple refs (loops each into the
history store); `analyze` does not (it writes a single `analysis.json`).

Accumulate 30-day trends with no external infra (see below):

```bash
bun run src/index.ts snapshot --ref <ref>   # schedule hourly; appends to ~/.sbperf/history.db
bun run src/index.ts report <dir>            # draws trends from accumulated snapshots
```

## What it collects

- **Advisors** - performance + security lints (Management API; richer than the CLI)
- **Read-only SQL** - `pg_stat_statements` outliers + most-frequent queries,
  table/index cache-hit % (with stats-window age), biggest tables, unused
  indexes, duplicate indexes, sequential-scan-heavy tables, threshold-aware
  autovacuum lag, txid wraparound, replication-slot lag, connection state +
  per-role usage
- **RLS policy audit** - flags policies re-evaluating `auth.*()` per row (should
  be wrapped in `(select ...)`; 94-99% latency win per Supabase's guide) and RLS
  policy columns without a covering index (seq scan per row check)
- **Metrics-derived signals** - swap in use (memory pressure), cumulative
  deadlocks, work_mem spill to disk (temp-file rate), and a `postgres_changes`
  -> Broadcast nudge for realtime at scale
- **Config** - Postgres version + upgrade drift, disk spec/util, pooler mode, PG tuning params (`pg_settings`)
- **Inventory** - edge functions (with per-function invocation stats: request
  volume, 5xx rate, execution time), storage buckets + object usage
- **Infra metrics** - the COMPLETE scrape (node_exporter + postgres_exporter +
  pgbouncer + supavisor + gotrue + realtime + postgREST, ~321 families) captured
  in full to `analysis.json`; no curation. The HTML report shows a readable
  key-metric slice; the whole corpus is in the data + the history store. 30-day
  trends accumulate via `snapshot` (see below)

Reports are structured as a pyramid: a ranked **findings summary** (Performance /
Security / Capacity) with a severity bar up top, a **"what's looking good"** pass
(confirmed-healthy checks, only asserted when actually measured), then
infrastructure, then collapsible evidence drill-downs with inline-SVG bar charts
on the query outliers. Paused/unreachable projects render an honest degraded
state, not misleading empties.

Every heuristic is grounded in `docs/heuristics.md` (thresholds cite Supabase/
Postgres sources). An on-by-default, soft-fail **sync check** annotates the
footer with the catalog vintage and whether the vendored advisor lint SQL still
matches upstream `supabase/splinter`; it skips silently when offline so runs stay
reproducible (`--no-sync-check` to disable). Live advisor lints are fetched per
run and are always current.

## Choosing a timeframe

Supabase only lets you pick a window for the **analytics** endpoints (API
request volume + edge-function stats). Use `--interval`:

```bash
bun run src/index.ts analyze --ref <ref> --interval 7day
```

Enum: `15min | 30min | 1hr | 3hr | 1day | 3day | 7day` (default `1day`). It sets
both window and granularity - `7day` gives ~daily buckets, `3day`/`1day` hourly,
`<=1hr` fine-grained recent. **Max reach is ~7 days**; arbitrary ISO ranges are
clamped by the API and don't extend history.

Everything else has no query window: infra **metrics** are a point-in-time
scrape, and **pg_stat_statements** / SQL diagnostics are cumulative since the
last stats reset (the report shows the reset age). For longer horizons, use the
history store (`snapshot` -> trends) - that's the only way to see beyond ~7 days.

## Auth

Either:
- set `SUPABASE_ACCESS_TOKEN` (a Personal Access Token), or
- just run `supabase login` - sbperf reads the CLI's stored token from
  `~/.supabase/access-token` automatically when the env var is unset.

(Resolution order: env var first, then the CLI token.) The per-project
service_role key used for the metrics endpoint is auto-fetched via the
Management API per run and never written to disk.

### Superuser SQL (your own projects): `--db-url`

The default SQL tier is the PAT read-only runner (`supabase_read_only_user`) -
no password, so it audits a customer project you only have a PAT for. When you
have superuser access (your own project's `supabase_admin` connstring, or any
Postgres), pass `--db-url` (or `SBPERF_DB_URL`) to run the diagnostics with full
access instead:

```bash
SBPERF_DB_URL='postgresql://supabase_admin:...@...pooler.supabase.com:6543/postgres' \
  bun run src/index.ts analyze --ref <ref>
```

This unlocks all schemas, real `inspect`-depth diagnostics, multiple/non-Supabase
databases, and (via `pg_stat_statements_reset()`) true query windows. It also
recovers the **Performance Advisor** when Supabase's hosted `advisors/performance`
endpoint is failing (a known splinter lint bug that 400s server-side): with a
`--db-url`, sbperf runs the vendored splinter lints itself over the simple-query
protocol and fills in the performance findings the API dropped. The PAT is
still used for the API planes (advisors, config, health) and the metrics
endpoint. The connstring is a secret - it's read from the flag/env and never
written to `analysis.json` (only which tier was used).

#### Multiple databases

`--db-url` is repeatable, and there's a gitignored config file. `full` sweeps
them into per-DB report dirs + an `index.html`; `snapshot` records each into the
history store. The Supabase project ref is auto-derived from each connstring
(pooler `role.ref` username or `db.<ref>.supabase.co` host), so a bare list Just
Works:

```bash
bun run src/index.ts full --db-url "$DB1" --db-url "$DB2"
```

Or a config file (`sbperf.databases.json`, gitignored - it holds connstrings):

```json
[
  { "name": "prod", "dbUrl": "postgresql://supabase_admin.<ref>:...@...:5432/postgres" },
  { "name": "legacy", "ref": "myref", "dbUrl": "postgresql://user:...@host:5432/db" }
]
```

```bash
bun run src/index.ts full --db-config sbperf.databases.json
```

`ref` is optional when derivable; set it explicitly for non-Supabase strings.

## 30-day trends

No Supabase API returns 30 days of infra history - the metrics endpoint is a
point-in-time scrape, and the analytics endpoints cap around 24h. Time series
**must** be accumulated going forward. sbperf is its own collector: no
Prometheus, no Grafana.

```bash
# schedule this (e.g. hourly cron / systemd timer):
bun run src/index.ts snapshot --ref <ref>
#   -> collects a full snapshot, appends to ~/.sbperf/history.db (SQLite),
#      prunes snapshots older than 90 days (--retention-days N, 0 = keep all)

# then any report draws trends from whatever history has accumulated:
bun run src/index.ts report <dir>
```

Trend series are downsampled at render time to ~300 points per panel (bucketed
average, the way Grafana renders a wide range), so a long history still draws a
clean sparkline. Snapshot resolution is your cron cadence; retention is a flat
prune at `--retention-days`.

Trends need >=2 snapshots to compute rates. Gauges (load, free memory/disk, DB
size) plot directly; **counters** (`node_cpu_*`, `node_disk_*`, `node_network_*`)
become CPU utilization %, disk IOPS, and throughput once two snapshots exist -
exactly the panels a Grafana node_exporter dashboard shows. History is not
retroactive; it accrues from your first `snapshot`.

Flags: `--store <db>` (default `~/.sbperf/history.db`, keyed by ref so one
store holds every project), `--retention-days <n>`.

### Feed the corpus to Grafana (retroactive)

The SQLite store is the collection source of truth; for full Grafana dashboards,
export it to Prometheus rather than reading the SVG trends. `export-prometheus`
writes the whole accumulated corpus as OpenMetrics with timestamps:

```bash
bun run src/index.ts export-prometheus /tmp/out --ref <ref>   # or omit --ref for all
```

It prints the exact `promtool` backfill command (promtool ships inside the
`prom/prometheus` image - no host install). Import straight into the
`scrape-init` stack's data volume, restart, and Grafana queries the full history
**retroactively** - Prometheus can't scrape the past, but it can ingest
backfilled blocks. Verified end-to-end against `prom/prometheus:v3.1.0`.

### Alternate source: an existing Prometheus

If you already run Prometheus scraping the metrics endpoint, skip the store and
pull trends from it instead:

```bash
bun run src/index.ts scrape-init --ref <ref>   # writes scraper-live/ (Prometheus + Grafana)
cd scraper-live && docker compose up -d
bun run src/index.ts full --ref <ref> --prometheus http://localhost:9090
```

`--prometheus` trends take precedence over the history store when both exist.

### Bring your own history (CSV / JSON import)

If your metrics history lives somewhere sbperf can't reach - a self-hosted Grafana,
a managed Prometheus, a spreadsheet - **export the series yourself and hand it to
the tool**. `import-trends` merges any external time series into
`analysis.trends`, so the report renders them as native inline-SVG panels instead
of pasted screenshots. sbperf never talks to your dashboard; it only ingests a
file you produced (so the tool stays vendor-neutral).

```bash
# in Grafana: open a time-series panel -> Inspect -> Data -> Download CSV
bun run src/index.ts import-trends ./reports/myproject cpu.csv disk-io.csv wal.csv
bun run src/index.ts report ./reports/myproject     # renders the imported panels
```

- **CSV (wide)** - first column is the timestamp, every other column is a series
  (its header is the panel title). A `Title [unit]` / `Title (unit)` header sets
  the unit (e.g. `Disk free [bytes]`). This is Grafana's default CSV export shape.
- **CSV (long)** - exactly three columns `time,series,value` (the Prometheus /
  tidy-data shape), grouped into one series per label. Auto-detected by header
  names or by sniffing; the series label may carry a `[unit]` too.
- **JSON** - a `TrendSeries[]` (`{title, unit?, points:[{t,v}]}`), a `{trends:[...]}`
  wrapper, or `[t,v]` tuple points.
- Timestamps may be ISO-8601 or epoch (seconds or milliseconds). Re-importing an
  updated file for the same series title replaces it (idempotent).

## Narrative (optional LLM pass)

The deterministic report is ground truth. `narrate` layers a written narrative on
top of it - an executive summary, prioritised actions, and per-finding root
cause + fix - by feeding an LLM the ranked findings (with their catalogued
remediation + doc URLs), the healthy positives, and a bounded evidence digest.

```bash
export SBPERF_LLM_BASE_URL=http://localhost:11434/v1   # any OpenAI-compatible endpoint
export SBPERF_LLM_MODEL=your-model-id                  # SBPERF_LLM_API_KEY if the endpoint needs one
bun run src/index.ts narrate ./reports/myproject       # -> narrative.md + narrative.html
bun run src/index.ts report ./reports/myproject --narrative   # embed it in report.html
```

`narrate` writes `narrative.md`, a standalone `narrative.html`, and stores the
text on `analysis.json`. The deterministic report stays LLM-free by default; pass
`--narrative` to `report`/`pdf` to embed the narrative as a clearly-labelled
section above the evidence (no re-run of the model needed).

Works with OpenAI, a local llama-server, OpenRouter, etc. The prompt forbids the
model from inventing thresholds, numbers, table names, or doc URLs not present in
the data, and requires it to caveat when collection was degraded - so the prose
stays grounded and auditable. It sends a size-bounded digest, not the full ~850-
sample corpus (which stays in `analysis.json`). No other command calls an LLM.

## Branding (white-label)

Reports carry **Supabase branding by default** - the Supabase logo mark, favicon,
and green colourway. Deliver a client-ready report as-is, or white-label it with
your own logo and colours.

```bash
cp sbperf.brand.json.example sbperf.brand.json   # auto-loaded from the cwd
# ...or: --brand path/to/brand.json  /  SBPERF_BRAND=path/to/brand.json
bun run src/index.ts report ./reports/myproject
```

Every field is optional and overrides the default:

```json
{
  "name": "Northwind Data",
  "accent": "#c026d3",
  "ink": "#7e1d8a",
  "logoPath": "./brand/logo.svg"
}
```

- `accent` - bright fills (chart bars, borders, badges); `ink` - links + sparkline
  strokes (pick a contrast-safe shade).
- `logoPath`/`faviconPath` are read and inlined (reports stay self-contained), or
  give `logoSvg`/`faviconSvg` directly. A logo with no explicit favicon is reused
  as the favicon.
- Precedence: `--brand` > `SBPERF_BRAND` > `./sbperf.brand.json` > Supabase default.
- The report *title* stays "Supabase performance report" (it analyses Supabase);
  branding controls who delivers it. `sbperf.brand.json` is gitignored.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SUPABASE_ACCESS_TOKEN is required` | Set the PAT (https://supabase.com/dashboard/account/tokens). |
| `cannot read project <ref>` / 401 | Wrong ref or the token lacks access to that project's org. |
| `no Chrome/Chromium found` | Install `chromium`, or `export SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` work without it - only `pdf` needs it. |
| `no analysis.json in <dir>` | Run `analyze` (or `full`) before `report`/`pdf`/`narrate`. |
| `narrate needs an LLM: set SBPERF_LLM_...` | Set `SBPERF_LLM_BASE_URL` + `SBPERF_LLM_MODEL` (see the Narrative section). |
| Footer says advisor lint SQL drifted / catalog stale | Re-vendor `src/splinter.sql` from `supabase/splinter`, or re-review `docs/heuristics.md`. Advisory only; `--no-sync-check` skips it. |
| Report shows a degraded/empty state | Project is paused or unreachable - empty sections mean "not collected", not "clean". The collection-notes section lists why. |

## Staying in sync with the API

sbperf curates its own set of Management API endpoints (PAT-only, no DB
password, no CLI dependency). `scripts/check-api-drift.ts` guards against
silent drift in two layers:

1. **Primary (pass/fail)** - asserts every endpoint sbperf calls still exists,
   with the method we use, in the **live** served spec
   (`api.supabase.com/api/v1-json`) - the ground truth for what the deployed API
   actually accepts. A renamed/removed endpoint fails CI (exit 1).
2. **Cross-check (advisory)** - diffs the live spec against the
   version-controlled copy in `supabase/supabase` (`apps/docs/spec`). That copy
   is generated *from* the API and can lag a deploy, so a divergence is an early
   warning that upstream is mid-change. Emitted as a GitHub Actions `::warning::`
   annotation; never fails the build on its own.

CI runs it on every push and weekly.

```bash
bun run check:api                    # live check + cross-check
SBPERF_NO_CROSSCHECK=1 bun run check:api   # primary only
```

## Development

```bash
bun run check        # biome format + lint
bun run typecheck    # tsc --noEmit
bun test             # unit tests
bun run check:api    # upstream Management API drift check (live spec, pass/fail)
bun run check:inspect # advisory: warn when upstream CLI inspect SQL drifts from our derived baseline
bun run build        # standalone binary
```

See `AGENTS.md` for architecture and conventions.
