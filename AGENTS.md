# sbperf

PAT-only Supabase performance analysis tool. Fetches advisors, read-only SQL
diagnostics, config, and metrics for a project and renders a self-contained
HTML + PDF report. No superuser `--db-url`, no manual Grafana screenshots.

## Stack

- Runtime: **Bun** + TypeScript (strict, `noUncheckedIndexedAccess`)
- Validation: **zod 4** - every external response is parsed at the boundary
- Lint/format: **biome 2**
- PDF: **headless Chromium** shelled out via `--print-to-pdf` (system binary discovered on PATH; no Playwright dep, so the compiled binary stays standalone)
- Tests: `bun test`

## Commands

| Command | Purpose |
|---|---|
| `bun run src/index.ts analyze --ref <ref>` | fetch all planes -> `analysis.json` |
| `bun run src/index.ts report <dir>` | `analysis.json` -> `report.html` |
| `bun run src/index.ts pdf <dir>` | `analysis.json` -> `report.pdf` |
| `bun run src/index.ts full --ref <ref>` | analyze + report + pdf |
| `bun run src/index.ts scrape-init --ref <ref>` | write the Prometheus+Grafana stack |
| `bun run check` | biome format + lint (write) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | run tests |
| `bun run build` | compile a standalone `sbperf` binary |

PDF needs a system Chrome/Chromium on PATH (`chromium`, `google-chrome`, ...) or `SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` need no browser.

## Transports

Auto-detected from env (`GATEKEEPER_URL` set -> gatekeeper, else direct;
override with `SBPERF_TRANSPORT`). See `.env.example`.

- **direct** - `SUPABASE_ACCESS_TOKEN`; hits `api.supabase.com` and
  `<ref>.supabase.co` metrics (service_role auto-fetched per run, never stored).
- **gatekeeper** - `GATEKEEPER_URL` + `GATEKEEPER_KEY`; proxies through the
  Gatekeeper IAM gateway (`/supabase/v1/*`, `/supabase/metrics/:ref`). One narrow
  key replaces both the PAT and the service_role secret - Gatekeeper swaps the
  real upstream credentials in server-side. See `~/gatekeeper`.

## Architecture (bounded contexts)

```
src/
  config.ts      zod env -> TransportConfig (direct | gatekeeper)
  transport.ts   Transport interface + Direct/Gatekeeper impls (auth + base URLs)
  management.ts  typed, zod-parsed Management API wrapper
  sql.ts         the perf query set (pg_stat_statements, seq_scan, n_dead_tup, ...)
  metrics.ts     Prometheus text parser + curated allowlist
  collect.ts     orchestrate all planes -> validated Analysis (per-source errors captured)
  report/render  Analysis -> self-contained HTML (utilitarian, print CSS)
  report/pdf     HTML -> PDF via Playwright
  scraper.ts     generate a going-forward Prometheus+Grafana stack
  index.ts       CLI
```

## Conventions

- Every API response has a zod schema in `schemas.ts`. **Never use `.default([])`
  to paper over a shape mismatch** - it silently masks upstream changes. Use
  `.refine()` to fail loud, then let `collect.ts`'s per-source `safe()` wrapper
  record it as a collection note. (Learned the hard way: the advisors REST
  endpoint wraps findings under `lints`, not `results`.)
- Generated reports contain customer query text - `reports/` is gitignored.
- Scraper dirs contain a live credential in `prometheus.yml` - gitignored.

## Verified upstream facts (Supabase, 2026-07)

- Advisors REST endpoint `/v1/projects/:ref/advisors/{performance,security}`
  returns `{ lints: [...] }` (richer than the CLI - includes INFO lints).
- Read-only SQL: `POST /v1/projects/:ref/database/query/read-only` runs as
  `supabase_read_only_user`; reaches `extensions.pg_stat_statements`, `pg_statio`,
  catalogs. No DB password needed.
- Metrics endpoint is point-in-time (scrape target), not a TSDB - 30-day trends
  need the `scrape-init` stack running over time.

## See also

- `~/.pi/agent/skills/supabase-postgres-best-practices` - source of the perf queries
- `~/.pi/agent/skills/supabase` - API/CLI/auth reference
- `~/.pi/agent/skills/design-utilitarian` - report visual ethos
- `~/gatekeeper` - the IAM gateway for gatekeeper transport
