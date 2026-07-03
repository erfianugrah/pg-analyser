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
| `bun run src/index.ts narrate <dir>` | `analysis.json` -> `narrative.md` (LLM pass; needs `SBPERF_LLM_*`) |
| `bun run src/index.ts import-trends <dir> <file...>` | merge external CSV/JSON series into `analysis.trends` (vendor-neutral; no dashboard coupling) |
| `bun run src/index.ts full --ref <ref>` | analyze + report + summary + pdf |
| `bun run src/index.ts snapshot --ref <ref>` | collect + append to the SQLite history store (cron this) |
| `bun run src/index.ts export-prometheus <dir> [--ref <ref>]` | history store -> OpenMetrics for promtool backfill |
| `bun run src/index.ts scrape-init --ref <ref>` | write the (alternate) Prometheus+Grafana stack |
| `bun run check` | biome format + lint (write) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run check:api` | assert endpoints still exist in the upstream OpenAPI spec |
| `bun run check:inspect` | warn when upstream CLI inspect SQL drifts from our derived baseline |
| `bun test` | run tests |
| `bun run build` | compile a standalone `sbperf` binary |

PDF needs a system Chrome/Chromium on PATH (`chromium`, `google-chrome`, ...) or `SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` need no browser.

## Auth

Set `SUPABASE_ACCESS_TOKEN` (Personal Access Token), or run `supabase login` and
sbperf reads `~/.supabase/access-token` automatically. Hits `api.supabase.com`
and the `<ref>.supabase.co` metrics endpoint (service_role auto-fetched per run
via the Management API, never stored). The `Transport` interface exists mainly
so tests can inject a fake; there is one impl (`DirectTransport`).

### SQL tiers (PAT vs superuser)

SQL diagnostics run through a `SqlRunner` (`sqlrunner.ts`):
- **PAT (default)** - `ManagementSqlRunner` -> the read-only SQL endpoint
  (`supabase_read_only_user`). No password; audits a customer project you only
  have a PAT for.
- **Superuser (`--db-url` or `SBPERF_DB_URL`)** - `DirectSqlRunner` runs each
  query directly over a Postgres connstring (e.g. Supabase's `supabase_admin`
  pooler connstring, or ANY Postgres) via `Bun.SQL` (`prepare:false` for
  transaction-pooler safety). Full access: real inspect, all schemas, multiple/
  non-Supabase DBs, and can `pg_stat_statements_reset()` to window queries.
  Currently AUGMENTS the PAT (API planes + metrics still use the PAT transport);
  pure no-PAT arbitrary-PG mode is a later step. The connstring is a secret -
  read from flag/env, never written to analysis.json (only `meta.sqlSource`).

## Architecture (bounded contexts)

```
src/
  config.ts      zod env -> Config (access token)
  transport.ts   Transport interface + DirectTransport (auth + retry)
  management.ts  typed, zod-parsed Management API wrapper
  sqlrunner.ts   SQL execution tiers behind one interface: ManagementSqlRunner
                 (PAT read-only runner, default) + DirectSqlRunner (superuser
                 --db-url via Bun.SQL - full access, any/multiple PG). collect
                 injects one; meta.sqlSource records which. Connstring NEVER stored.
  splinter.ts    self-hosted Performance Advisor: runs the vendored splinter.sql
                 (src/splinter.sql, Apache-2.0) over a superuser --db-url via
                 the simple-query protocol, as a fallback when the hosted
                 advisors/performance endpoint 400s (the 42601 lint bug).
  dbtargets.ts   multi-DB: parse repeatable --db-url + --db-config (gitignored
                 sbperf.databases.json); refFromConnstring auto-derives the
                 Supabase ref (pooler role.ref / db.<ref> host). `full` sweeps
                 targets -> per-DB reports + index; `snapshot` records each.
  sql.ts         the perf query set - superset of `supabase inspect db`:
                 pg_stat_statements (by time + calls), index-stats, bloat,
                 traffic-profile, threshold-aware vacuum, txid wraparound,
                 replication slots, role-stats, point-in-time locks/blocking/
                 long-running, cache-hit + stats-reset age, RLS audit
  metrics.ts     Prometheus text parser + DISPLAY-only allowlist (collect
                 captures the FULL scrape; curate() only picks the HTML slice)
  collect.ts     orchestrate all planes -> validated Analysis (per-source errors
                 captured); captures the COMPLETE metrics corpus (all ~321
                 families, no curation) - the corpus is the product
  report/render  Analysis -> self-contained HTML (utilitarian, print CSS,
                 positives pass + inline-SVG bar charts + severity bar).
                 render(a,{narrative}) embeds the LLM narrative on demand;
                 renderNarrativePage(a) is the standalone narrative.html.
  report/markdown minimal, HTML-escaping Markdown->HTML for the narrate subset
                 (headings/lists/bold/code/fenced/links); NOT a general parser
  report/pdf     HTML -> PDF via headless Chromium --print-to-pdf (no Playwright
                 dep; system Chrome discovered on PATH or SBPERF_CHROME)
  narrate.ts     LLM pass over the corpus + enriched findings -> narrative.md.
                 Grounded: hands the model the ranked findings (with catalogued
                 remediation + doc URL), positives, and a BOUNDED evidence digest
                 (not the whole corpus); system prompt forbids inventing facts.
                 OpenAI-compatible client (OpenAI / local llama-server / ...),
                 injectable for tests; SBPERF_LLM_BASE_URL + _MODEL (+ _API_KEY).
  sync.ts        on-by-default soft-fail upstream sync check -> analysis.sync:
                 catalog vintage/age + vendored splinter.sql vs upstream hash;
                 rendered in the report footer. --no-sync-check to skip.
  store.ts       SQLite history store (bun:sqlite): `snapshot` appends full
                 Analysis + denormalized metric_samples/sql_scalars; keyed by
                 ref at ~/.sbperf/history.db; prune to retention
  trends.ts      pure computeTrends: gauges (1 pt/snapshot) + counter-derived
                 rates (CPU util %, IOPS, throughput) across >=2 snapshots
  promexport.ts  history store -> OpenMetrics (timestamped) for `export-prometheus`;
                 promtool backfills a Prometheus TSDB -> retroactive Grafana
  scraper.ts     generate a going-forward Prometheus+Grafana stack (alternate
                 trend source; `report` prefers --prometheus over the store)
  importtrends.ts vendor-neutral trend import: parse external CSV (wide: time +
                 series columns, "Title [unit]" headers) / JSON (TrendSeries[] or
                 {t,v}/[t,v] points; ISO or epoch s/ms) -> merge into
                 analysis.trends (same-title replaces). For bringing your own
                 30-day history (e.g. a Grafana CSV export) into the report
                 WITHOUT coupling the public tool to any dashboard.
  index.ts       CLI
```

## Conventions

- **Derive checks from upstream source; never depend on the CLI at runtime.**
  sbperf stays API-first (Management API + read-only/superuser SQL + the metrics
  endpoint) so it syncs with upstream and doesn't inherit the CLI's release lag.
  But when writing a diagnostic, PORT the actual query from the canonical source
  rather than hand-rolling: `supabase/cli` `apps/cli-go/internal/inspect/*/*.sql`
  for inspect-style diagnostics, and `supabase/splinter` (`splinter.sql`, already
  vendored) for advisor lints. Hand-rolled reimplementations drift and get subtly
  wrong - e.g. the RLS unwrapped-auth check false-flagged correctly-wrapped
  policies until it was aligned to how Postgres actually stores the expression.
  Only write ORIGINAL checks where upstream has a real gap AND the Postgres docs
  justify it (e.g. the txid-wraparound check the CLI's vacuum-stats lacks).
  We do NOT vendor the inspect queries verbatim (they use `LIKE ANY($1)` bind
  params the PAT read-only endpoint can't bind, and our findings need raw columns
  the CLI wraps in `pg_size_pretty()`). Instead `scripts/check-inspect-drift.ts`
  fingerprints each upstream inspect query in `scripts/inspect-baseline.json` and
  WARNS (advisory) when upstream changes, so you re-review the derived query in
  `sql.ts`. When you adapt a new inspect query, add it to that script's MANIFEST
  and run `SBPERF_INSPECT_UPDATE=1 bun run check:inspect` to record the baseline.


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
- KNOWN BUG (2026-07): the hosted `advisors/performance` endpoint runs the
  splinter lint SQL server-side and currently 400s with `42601 syntax error at
  or near "'storage.buckets'"` - the multi-statement storage-buckets lint on the
  prepared-statement path (supabase/cli#4965; fixed in the CLI, not yet on the
  hosted endpoint). `advisors/security` is unaffected. FALLBACK: with a
  superuser --db-url, collect runs the vendored splinter.sql itself over the
  simple-query protocol (multi-statement tolerant) and populates
  advisors.performance from it (splinter.ts + DirectSqlRunner.runMulti). The
  hosted 400 is still recorded as a harmless collection note.
- Read-only SQL: `POST /v1/projects/:ref/database/query/read-only` runs as
  `supabase_read_only_user`; reaches `extensions.pg_stat_statements`, `pg_statio`,
  catalogs. No DB password needed.
- Metrics endpoint is essentially node_exporter + postgres_exporter + pgbouncer
  + supavisor + gotrue + realtime + postgREST + db_sql, ~321 families / ~850
  samples on a real project. `collect` captures ALL of it (no curation) into
  analysis.json + the SQLite store - the complete corpus is the product, and
  the deterministic report curates only for the HTML display slice. Design
  intent (2026-07): collect the whole corpus now; analysis/report/PDF becomes an
  LLM pass over the corpus later. Never gate storage behind the display allowlist.
- Metrics endpoint is point-in-time (scrape target), not a TSDB, and takes NO
  time param; the analytics endpoints cap ~24h (verified 2026-07: interval=1day
  returns 24 hourly buckets). So NO single API call yields 30 days of anything -
  time series must be accumulated going forward. sbperf does this itself via
  `snapshot` -> SQLite (`store.ts`); no Prometheus/Grafana required. For full
  Grafana dashboards, `export-prometheus` renders the store as OpenMetrics with
  timestamps (`promexport.ts`, TYPE=unknown to sidestep OM suffix strictness);
  `promtool tsdb create-blocks-from openmetrics` (two tokens; ships in the
  prom/prometheus image, run --user 65534) backfills the scrape-init volume so
  Grafana queries history RETROACTIVELY. Verified live vs prom/prometheus:v3.1.0.
  The metrics
  allowlist keeps the counter families (node_cpu/disk/network *_total) so rates
  (CPU%, IOPS, throughput) are computable once >=2 snapshots exist - a single
  scrape of a counter is meaningless, which is why the point-in-time report
  curates gauges only but the trend path needs the counters.
- Per-function invocation stats: `GET /v1/projects/:ref/analytics/endpoints/
  functions.combined-stats?interval=<window>&function_id=<id>` returns
  per-time-bucket `{ request_count, success_count, client_err_count,
  server_err_count, avg/min/max_execution_time }`. Needs the function `id` from
  the functions list, not the slug. collect.ts aggregates buckets per function.
- Analytics timeframe (verified live 2026-07): the `interval` enum is
  `15min | 30min | 1hr | 3hr | 1day | 3day | 7day` (an invalid value 400s with
  the full list in the message). It sets BOTH window and granularity: `7day` ->
  ~8 daily buckets, `3day`/`1day` -> hourly, `<=1hr` -> fine-grained recent.
  Max reach is ~7 days. `iso_timestamp_start`/`iso_timestamp_end` are accepted
  but CLAMPED - a 14/30/90-day range returns only the last few minutes, so they
  do NOT extend history. Applies to both `usage.api-counts` and
  `functions.combined-stats`. Exposed as `--interval` (default 1day); threaded
  through collect.ts. This is the ONLY query window Supabase offers - metrics
  are point-in-time and pg_stat_statements is cumulative-since-reset.
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
