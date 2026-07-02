# sbperf

Supabase performance analysis, PAT-only. Pulls advisors, read-only SQL
diagnostics, project config, and infra metrics, and renders a self-contained
**HTML + PDF** report you can drag straight into an email or Slack.

Replaces the manual "run the CLI, screenshot Grafana six times, upload to a
Claude project" workflow with one reproducible command - no superuser
connection string, no screenshots.

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
```

`report`/`pdf` emit two documents: the full technical **report** and a
non-technical one-page **summary** (plain-language verdict for a non-engineering
audience).

Audit every project in the account (writes an `index.html` linking them all):

```bash
bun run src/index.ts full --all [--org <slug>]
```

Accumulate 30-day trends with no external infra (see below):

```bash
bun run src/index.ts snapshot --ref <ref>   # schedule hourly; appends to ~/.sbperf/history.db
bun run src/index.ts report <dir>            # draws trends from accumulated snapshots
```

## What it collects

- **Advisors** - performance + security lints (Management API; richer than the CLI)
- **Read-only SQL** - `pg_stat_statements` outliers + most-frequent queries,
  table/index cache-hit % (with stats-window age), biggest tables, unused
  indexes, sequential-scan-heavy tables, threshold-aware autovacuum lag, txid
  wraparound, replication-slot lag, connection state + per-role usage
- **RLS policy audit** - flags policies re-evaluating `auth.*()` per row (should be wrapped in `(select ...)`; 94-99% latency win per Supabase's guide)
- **Config** - Postgres version + upgrade drift, disk spec/util, pooler mode, PG tuning params (`pg_settings`)
- **Inventory** - edge functions (with per-function invocation stats: request
  volume, 5xx rate, execution time), storage buckets + object usage
- **Infra metrics** - the COMPLETE scrape (node_exporter + postgres_exporter +
  pgbouncer + supavisor + gotrue + realtime + postgREST, ~321 families) captured
  in full to `analysis.json`; no curation. The HTML report shows a readable
  key-metric slice; the whole corpus is in the data + the history store. 30-day
  trends accumulate via `snapshot` (see below)

Reports are structured as a pyramid: a ranked **findings summary** (Performance / Security / Capacity) up top, then infrastructure, then collapsible evidence drill-downs. Paused/unreachable projects render an honest degraded state, not misleading empties.

## Auth

Either:
- set `SUPABASE_ACCESS_TOKEN` (a Personal Access Token), or
- just run `supabase login` - sbperf reads the CLI's stored token from
  `~/.supabase/access-token` automatically when the env var is unset.

(Resolution order: env var first, then the CLI token.) The per-project
service_role key used for the metrics endpoint is auto-fetched via the
Management API per run and never written to disk.

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

### Alternate source: an existing Prometheus

If you already run Prometheus scraping the metrics endpoint, skip the store and
pull trends from it instead:

```bash
bun run src/index.ts scrape-init --ref <ref>   # writes scraper-live/ (Prometheus + Grafana)
cd scraper-live && docker compose up -d
bun run src/index.ts full --ref <ref> --prometheus http://localhost:9090
```

`--prometheus` trends take precedence over the history store when both exist.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SUPABASE_ACCESS_TOKEN is required` | Set the PAT (https://supabase.com/dashboard/account/tokens). |
| `cannot read project <ref>` / 401 | Wrong ref or the token lacks access to that project's org. |
| `no Chrome/Chromium found` | Install `chromium`, or `export SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` work without it - only `pdf` needs it. |
| `no analysis.json in <dir>` | Run `analyze` (or `full`) before `report`/`pdf`. |
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
bun run check       # biome format + lint
bun run typecheck   # tsc --noEmit
bun test            # unit tests
bun run check:api   # upstream API drift check
bun run build       # standalone binary
```

See `AGENTS.md` for architecture and conventions.
