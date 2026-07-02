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

Embed real 30-day trend charts (needs a running scraper, see below):

```bash
bun run src/index.ts full --ref <ref> --prometheus http://localhost:9090
```

## What it collects

- **Advisors** - performance + security lints (Management API; richer than the CLI)
- **Read-only SQL** - `pg_stat_statements` outliers, cache-hit %, biggest tables,
  unused indexes, sequential-scan-heavy tables, dead-tuple bloat, connection state
- **RLS policy audit** - flags policies re-evaluating `auth.*()` per row (should be wrapped in `(select ...)`; 94-99% latency win per Supabase's guide)
- **Config** - Postgres version + upgrade drift, disk spec/util, pooler mode, PG tuning params (`pg_settings`)
- **Inventory** - edge functions (with per-function invocation stats: request
  volume, 5xx rate, execution time), storage buckets + object usage
- **Infra metrics** - point-in-time snapshot; optional 30-day trends via `--prometheus`

Reports are structured as a pyramid: a ranked **findings summary** (Performance / Security / Capacity) up top, then infrastructure, then collapsible evidence drill-downs. Paused/unreachable projects render an honest degraded state, not misleading empties.

## Auth

Set `SUPABASE_ACCESS_TOKEN` (a Personal Access Token). The per-project
service_role key used for the metrics endpoint is auto-fetched via the
Management API per run and never written to disk.

## 30-day trends

The metrics endpoint is point-in-time only. For real time-series history:

```bash
bun run src/index.ts scrape-init --ref <ref>   # writes scraper-live/
cd scraper-live && docker compose up -d         # Prometheus + Grafana, 90d retention
```

History accumulates from when you start scraping - it is not retroactive.

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
password, no CLI dependency). To avoid silently drifting when Supabase changes
the API, `scripts/check-api-drift.ts` asserts every endpoint sbperf uses still
exists - with the method we call - in the upstream OpenAPI spec
(`api.supabase.com/api/v1-json`). CI runs it on every push and weekly.

```bash
bun run check:api   # fails loudly if an endpoint was renamed/removed upstream
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
