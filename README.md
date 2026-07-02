# sbperf

Supabase performance analysis, PAT-only. Pulls advisors, read-only SQL
diagnostics, project config, and infra metrics, and renders a self-contained
**HTML + PDF** report you can drag straight into an email or Slack.

Replaces the manual "run the CLI, screenshot Grafana six times, upload to a
Claude project" workflow with one reproducible command - no superuser
connection string, no screenshots.

## Quick start

```bash
bun install
cp .env.example .env          # add SUPABASE_ACCESS_TOKEN (or Gatekeeper creds)
# PDF needs a system Chrome/Chromium on PATH (or set SBPERF_CHROME)

bun run src/index.ts full --ref <project-ref>
# -> reports/<ref>-<ts>/{analysis.json, report.html, report.pdf}
```

Or step by step:

```bash
bun run src/index.ts analyze --ref <ref> --out ./reports/acme
bun run src/index.ts report ./reports/acme     # HTML
bun run src/index.ts pdf    ./reports/acme     # PDF
```

## What it collects

- **Advisors** - performance + security lints (Management API; richer than the CLI)
- **Read-only SQL** - `pg_stat_statements` outliers, cache-hit %, biggest tables,
  unused indexes, sequential-scan-heavy tables, dead-tuple bloat, connection state
- **Config** - Postgres version + upgrade drift, disk spec/util, pooler mode, PG tuning params
- **Infra metrics** - point-in-time snapshot from the project metrics endpoint

## Transports

| Mode | Env | Notes |
|---|---|---|
| direct | `SUPABASE_ACCESS_TOKEN` | service_role for metrics is auto-fetched per run, never written to disk |
| gatekeeper | `GATEKEEPER_URL` + `GATEKEEPER_KEY` | one narrow IAM key; never touches the PAT or service_role |

## 30-day trends

The metrics endpoint is point-in-time only. For real time-series history:

```bash
bun run src/index.ts scrape-init --ref <ref>   # writes scraper-live/
cd scraper-live && docker compose up -d         # Prometheus + Grafana, 90d retention
```

History accumulates from when you start scraping - it is not retroactive.

## Development

```bash
bun run check       # biome format + lint
bun run typecheck   # tsc --noEmit
bun test            # unit tests
bun run build       # standalone binary
```

See `AGENTS.md` for architecture and conventions.
