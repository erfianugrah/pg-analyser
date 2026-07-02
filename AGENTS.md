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
| `bun run src/index.ts report <dir>` | `analysis.json` -> `report.html` + `summary.html` |
| `bun run src/index.ts summary <dir>` | `analysis.json` -> `summary.html` (non-technical) |
| `bun run src/index.ts pdf <dir>` | `analysis.json` -> `report.pdf` + `summary.pdf` |
| `bun run src/index.ts full --ref <ref>` | analyze + report + summary + pdf |
| `bun run src/index.ts scrape-init --ref <ref>` | write the Prometheus+Grafana stack |
| `bun run check` | biome format + lint (write) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run check:api` | assert endpoints still exist in the upstream OpenAPI spec |
| `bun test` | run tests |
| `bun run build` | compile a standalone `sbperf` binary |

PDF needs a system Chrome/Chromium on PATH (`chromium`, `google-chrome`, ...) or `SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` need no browser.

## Auth

Set `SUPABASE_ACCESS_TOKEN` (Personal Access Token), or run `supabase login` and
sbperf reads `~/.supabase/access-token` automatically. Hits `api.supabase.com`
and the `<ref>.supabase.co` metrics endpoint (service_role auto-fetched per run
via the Management API, never stored). The `Transport` interface exists mainly
so tests can inject a fake; there is one impl (`DirectTransport`).

## Architecture (bounded contexts)

```
src/
  config.ts      zod env -> Config (access token)
  transport.ts   Transport interface + DirectTransport (auth + retry)
  management.ts  typed, zod-parsed Management API wrapper
  sql.ts         the perf query set - superset of `supabase inspect db`:
                 pg_stat_statements (by time + calls), index-stats, bloat,
                 traffic-profile, threshold-aware vacuum, txid wraparound,
                 replication slots, role-stats, point-in-time locks/blocking/
                 long-running, cache-hit + stats-reset age, RLS audit
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
- Generated reports contain live query text - `reports/` is gitignored.
- Scraper dirs contain a live credential in `prometheus.yml` - gitignored.

## Verified upstream facts (Supabase, 2026-07)

- Advisors REST endpoint `/v1/projects/:ref/advisors/{performance,security}`
  returns `{ lints: [...] }` (richer than the CLI - includes INFO lints).
- Read-only SQL: `POST /v1/projects/:ref/database/query/read-only` runs as
  `supabase_read_only_user`; reaches `extensions.pg_stat_statements`, `pg_statio`,
  catalogs. No DB password needed.
- Metrics endpoint is point-in-time (scrape target), not a TSDB - 30-day trends
  need the `scrape-init` stack running over time.
- Per-function invocation stats: `GET /v1/projects/:ref/analytics/endpoints/
  functions.combined-stats?interval=<15min|1hr|3hr|1day>&function_id=<id>` returns
  per-time-bucket `{ request_count, success_count, client_err_count,
  server_err_count, avg/min/max_execution_time }`. Needs the function `id` from
  the functions list, not the slug. collect.ts aggregates buckets per function.
- `supabase inspect report` (the CLI's all-in-one) requires a DB connection
  string (`--db-url`/`--linked` = a password) and emits raw CSV - no findings.
  sbperf is PAT-only + ranked findings, and additionally has advisors, metrics,
  RLS audit, txid wraparound, and edge-function stats the CLI lacks. Coverage was
  compared against the CLI's ACTUAL query source
  (github.com/supabase/cli `apps/cli-go/internal/inspect/*/*.sql`), not its help
  text. NOTE: the CLI's vacuum-stats has NO txid/relfrozenxid logic (it is
  autovacuum-threshold analysis) - sbperf's txid check is original. Remaining
  CLI-only gaps deliberately left: real bloat estimation, traffic-profile.
- The endpoints sbperf depends on are asserted against the upstream OpenAPI spec
  by `scripts/check-api-drift.ts` in CI - this is how we stay in sync without a
  CLI dependency or manual tracking. Two layers: PRIMARY (pass/fail) checks the
  LIVE served spec (`api.supabase.com/api/v1-json`) - ground truth for what the
  deployed API accepts; CROSS-CHECK (advisory `::warning::`) diffs live against
  the version-controlled docs copy (`supabase/supabase` `apps/docs/spec`), which
  is generated from the API and can lag a deploy. When you add/rename a
  Management API call in `management.ts`, update the manifest in that script.

## See also

- `~/.pi/agent/skills/supabase-postgres-best-practices` - source of the perf queries
- `~/.pi/agent/skills/supabase` - API/CLI/auth reference
- `~/.pi/agent/skills/design-utilitarian` - report visual ethos
