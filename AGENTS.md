# sbperf

Supabase performance + health analysis tool. Fetches advisors, SQL diagnostics,
config, and metrics for a project and renders a self-contained HTML + PDF report.
Three source tiers: PAT-only (Management API + read-only SQL - zero DB
credentials), superuser `--db-url` (deep SQL: WAL-dir size, pg_hba, exact bloat,
amcheck integrity - AUGMENTS the PAT), and no-PAT (`--db-url` + Grafana alone).
The maximal-coverage fleet command is `full --all --db-config <json>` (PAT
enumerates + serves API/metrics; matched projects upgrade to superuser SQL).

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
| `bun run src/index.ts report <dir>` | `analysis.json` -> `report.html` (combined technical + business pyramid) |
| `bun run src/index.ts summary <dir>` | `analysis.json` -> `summary.html` (optional standalone plain-language one-pager) |
| `bun run src/index.ts pdf <dir>` | `analysis.json` -> `report.pdf` |
| `bun run src/index.ts narrate <dir>` | `analysis.json` -> `narrative.md` (LLM pass; needs `SBPERF_LLM_*`) |
| `bun run src/index.ts import-trends <dir> <file...>` | merge external CSV/JSON series into `analysis.trends` (vendor-neutral; no dashboard coupling) |
| `bun run src/index.ts diff <dirA> <dirB>` | findings delta + per-query (queryid) regressions between two runs |
| `bun run src/index.ts diff --ref <ref>` | same, over the two most recent history-store snapshots |
| `bun run src/index.ts check <dir> --fail-on <sev>` | CI gate: exit nonzero if findings breach the threshold (`--category`, `--new-since`) |
| `bun run src/index.ts full --ref <ref>` | analyze + report + pdf |
| `bun run src/index.ts full --ref <r1>,<r2> ...` / `--ref-file <f>` | audit a subset of projects -> combined org/project index (PAT-only). `--ref` repeatable + comma/space lists; `--ref-file` reads a .txt/.csv (ref-shaped tokens only) |
| `bun run src/index.ts full --all [--org <slug>]` | audit every project -> `index.html`. Projects whose ref matches a connstring (`--db-config` / `--db-url` / `SBPERF_DB_URL` / auto-loaded `sbperf.databases.json`) are AUTO-UPGRADED to the superuser SQL tier (PAT still serves API planes + metrics) - the maximal-coverage fleet command: `full --all --db-config <json> [--amcheck]` |
| `bun run src/index.ts full --profile <file.json>` | no-PAT sweep: force-no-PAT + per-region Grafana + target DBs, all in one gitignored JSON -> per-DB reports + index |
| `bun run src/index.ts full --db-url <connstr>` | superuser SQL tier (augments the PAT, or SOLE source in no-PAT mode); repeatable / `--db-config <file>` for a multi-DB sweep |
| `bun run src/index.ts analyze --ref <ref> --db-url <c> --amcheck[ heap]` | opt-in data-integrity: `bt_index_check` on app B-tree indexes (light); `heap` adds `verify_heapam` (heavy). Superuser + amcheck-installed only; never CREATEs the extension |
| `bun run src/index.ts snapshot --ref <ref>` | collect + append to the SQLite history store (cron this) |
| `bun run src/index.ts export-prometheus <dir> [--ref <ref>]` | history store -> OpenMetrics for promtool backfill |
| `bun run src/index.ts scrape-init --ref <ref>` | write the (alternate) Prometheus+Grafana stack |
| `bun run check` | biome format + lint (write) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run check:api` | assert endpoints still exist in the upstream OpenAPI spec |
| `bun run check:inspect` | warn when upstream CLI inspect SQL drifts from our derived baseline |
| `bun run check:lints` | warn when splinter lints drift from the src/lints.ts fix catalog |
| `bun run check:schemas` | warn when the app-schema denylist (src/appschema.ts) drifts from splinter.sql's unused_index exclusions |
| `bun test` | run tests |
| `bun run build` | compile a standalone `sbperf` binary |

PDF needs a system Chrome/Chromium on PATH (`chromium`, `google-chrome`, ...) or `SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` need no browser.

## Auth

Set `SUPABASE_ACCESS_TOKEN` (Personal Access Token), or run `supabase login` and
sbperf reads `~/.supabase/access-token` automatically. Hits `api.supabase.com`
and the `<ref>.supabase.co` metrics endpoint (service_role auto-fetched per run
via the Management API, never stored). The `Transport` interface exists mainly
so tests can inject a fake; there is one impl (`DirectTransport`).

**No-PAT mode** (`collect(ref, null, ...)`): with NO PAT resolvable but a
superuser `--db-url` (or `SBPERF_DB_URL` / `sbperf.databases.json`), `collect`
runs transport-free - `loadConfigOptional()` returns null instead of throwing,
every Management-API plane is skipped (returns its fallback, one summary
collection note - NOT per-plane 401 spam), advisors come from the self-hosted
splinter lints (`collectSplinterLints` fills BOTH performance and security), SQL
from the injected `DirectSqlRunner`, trends from Grafana if `SBPERF_PROMETHEUS_*`
is set. `meta.managementApi=false` drives a report banner + footer stating what
was NOT collected (provisioning/backups/pooler/metrics/analytics). This is the
no-PAT path (continued below).

**No-PAT SQL fill-ins** (the Management API only PROXIES Postgres for a subset
of planes, so a superuser `--db-url` reaches that data directly):
- **buckets** <- `storage.buckets` (`bucketList` query) - the same table the
  Storage API reads. Rendered, so no-PAT reports show the bucket inventory.
- **pgConfig** <- `pg_settings` (the GUC superset we already collect;
  `/config/database/postgres` is a subset). analysis.json only - the report's
  "PG tuning params" section already renders `pgSettings`, so no separate UI.
  The `pgSettings` allowlist also feeds the static GUC-tuning findings
  (`configTuningFindings`): work_mem blast radius, unbounded timeouts,
  checkpoint_completion_target, track_io_timing off. maintenance_work_mem is
  RAM-RELATIVE (Supabase tier-scales it, so a small value on a small instance
  is correct - only flagged when <3% of est RAM on a >=8GB box); lock_timeout=0
  is intentionally NOT flagged (a cluster-wide lock_timeout cancels legit waits).
- **WAL directory size** <- `pg_ls_waldir()` (`walDirSize` query, SUPERUSER-
  gated like hbaRules - the PAT read-only user is denied it). WAL lives on the
  data volume, so this is provisioned disk not in pg_database_size; shown in the
  infra section and feeds the disk over-provisioning true-footprint context.
- **checksum failures** <- `pg_stat_database.checksum_failures` (`checksumFailures`
  query, BOTH modes, no extension). Nonzero = on-disk corruption caught by the
  checksum layer -> high finding `checksum_failure`. Rendered as a status row.
- **amcheck integrity** <- `bt_index_check` / `verify_heapam` (opt-in `--amcheck`;
  SUPERUSER + amcheck-installed only; never CREATEs it). Index check calls
  bt_index_check per app B-tree index (it RAISES on corruption, so a thrown
  error is the hit); the heavier heap check (verify_heapam, reads every page)
  is row-returning and gated behind `--amcheck heap`. -> high findings
  `index_corruption` / `heap_corruption`.
- **PITR proxy** <- `pg_stat_archiver` + `archive_mode` (`walArchiving` query).
  Positive when archive_mode on/always + archived_count>0 ("Continuous WAL
  archiving is active"); low finding `pitr_absent` when not. INFERENCE, not the
  add-on flag - keyed on archive_mode+count, NOT last_archived_time age (idle
  projects skip WAL backups even with PITR on). Gated to no-PAT so it never
  contradicts the authoritative `backups.pitr_enabled`.
- **pg_hba weak-auth** <- `pg_hba_file_rules` (`hbaRules` query, needs a TRUE
  superuser - `supabase_admin`, NOT the `postgres` role, verified vs the
  supabase/postgres image). Med finding `hba_weak_auth` when a trust/password/
  ident rule exists for a NON-loopback, non-replication address (a real auth
  bypass). NOT an SSL check: Supabase's standard pg_hba is all
  `host ... scram-sha-256` with TLS terminated at the proxy, so host-vs-hostssl
  is noise that matches every project (this was the retune after a real run).
  GATED to the superuser SQL tier in collect.ts (`runner.source === "superuser"`):
  the PAT read-only user (`supabase_read_only_user`) is always denied
  `pg_hba_file_rules` with 42501, so attempting it in PAT mode can never succeed
  and only spams a warn+note on every run. It runs whenever a superuser --db-url
  is present (no-PAT OR PAT+--db-url); a PAT alone never triggers it. The tier
  flag can't see the role INSIDE a superuser connstring, so a `postgres`-role
  --db-url still 42501s through the normal `safe()` note - the gate only kills
  the guaranteed-failure read-only path.
- **Genuinely NOT reachable via SQL** (platform/infra, correctly left null/[]):
  service health, disk provisioning (size/IOPS/type), pooler CONFIG (Supavisor),
  GoTrue authConfig, network restrictions (cloud firewall), edge functions,
  api/function analytics (Logflare), node_exporter host + component metrics.

**Two settled design questions** (don't re-litigate):
- **Project display name in no-PAT**: NOT derivable via SQL - the friendly name
  is platform metadata, not stored in the DB. We auto-derive `ref` + `region`
  from the connstring (dbtargets.ts); `name` is optional in the profile and
  falls back to `ref`. Put `name` in the profile JSON only if you want the label.
- **changelogUrl is curated, NOT LLM-driven, on purpose**: the per-finding
  changelog links are hardcoded because an LLM picking changelog URLs would
  fabricate them - exactly what narrate's grounding forbids. Current curated set
  (all verified 200 against supabase.com/changelog): pg_graphql exposure lints
  (45329, lints.ts); connection findings direct_conn_high/connections_ceiling
  (32755, session-mode-6543 deprecation); network_restrictions_open (20522,
  Supavisor network restrictions); pg_cron cron_job_failing/pg_cron_review
  (19298, cron.job direct-update restriction); plus the auto-derived PG-release
  URL on pg_update_available. `test/heuristics.test.ts` asserts every
  changelogUrl matches the changelog/release URL shape. Expand the catalog to
  add coverage (find the entry at supabase.com/changelog, verify it 200s, wire
  it to the finding's heuristic); never make it dynamic. The `diff` command
  (run-to-run changelog) is likewise deterministic by design - a diff must be exact.

The no-PAT path: a DB connstring + optional Grafana cookie, no PAT -
equivalent to `supabase inspect db` plus ranked findings, splinter advisors, and
trends. `--all` still needs a PAT (it enumerates projects via the Management
API); the explicit `--db-url` / `sbperf.databases.json` sweep (`doAllDbs`) is the
no-PAT multi-DB path. The db-url SQL + splinter are drift-synced by
`check:inspect` + `check:lints` + `check:schemas` (all advisory) - this mode's
sync guarantee the way `check:api` is for PAT mode.

**Profile** (`--profile <file.json>`, `profile.ts`): the whole no-PAT
config in ONE gitignored JSON - `{ noPat, grafana: { hostTemplate, datasourceUid,
matcher, regions: { <region>: { cookie, uid?, host? } } }, databases: [...] }`.
`full --profile <f>` forces no-PAT (`profile.noPat`, default true), makes
`databases[]` the sweep targets, and always routes through `doAllDbs`. Each
regional Grafana is a separate ALB (per-region session cookie), so trends are
resolved PER PROJECT: `regionFromConnstring` derives the region from the
connstring, `resolveGrafana` maps it to that region's host/uid/cookie (host from
`hostTemplate.{region}` or a per-region override), and only `{ref}` stays
templated in the matcher. A region absent from the map -> that project's trends
are skipped (SQL/advisors still run). Nothing internal is baked into the repo:
hosts, UIDs, cookies and connstrings all live in the gitignored profile
(`sbperf.profile.json` / `sbperf.*.profile.json`; keep `.example`). Supersedes
`sbperf.databases.json` for the work case (it's a superset); overlays are a
separate presentation layer and untouched.

### SQL tiers (PAT vs superuser)

SQL diagnostics run through a `SqlRunner` (`sqlrunner.ts`):
- **PAT (default)** - `ManagementSqlRunner` -> the read-only SQL endpoint
  (`supabase_read_only_user`). No password; audits a project you only
  have a PAT for.
- **Superuser (`--db-url` or `SBPERF_DB_URL`)** - `DirectSqlRunner` runs each
  query directly over a Postgres connstring (e.g. Supabase's `supabase_admin`
  pooler connstring, or ANY Postgres) via `Bun.SQL` (`prepare:false` for
  transaction-pooler safety). Full access: real inspect, all schemas, multiple/
  non-Supabase DBs, and can `pg_stat_statements_reset()` to window queries.
  AUGMENTS the PAT when one is present (API planes + metrics still use the PAT
  transport). With NO PAT it is the SOLE data source - see "No-PAT mode" above.
  The connstring is a secret - read from flag/env, never written to
  analysis.json (only `meta.sqlSource`).

## Architecture (bounded contexts)

```
src/
  config.ts      zod env -> Config (access token)
  log.ts         zero-dep structured logger (NOT pino - worker-thread
                 transports don't survive `bun build --compile`). stderr only
                 (stdout reserved for report/JSON); SBPERF_LOG_LEVEL +
                 SBPERF_LOG=json; .child() binds fields, .time() emits
                 durationMs. collect() logs per-plane timing + a summary and
                 records meta.collectionMs (shown in the report footer).
                 collect() takes opts.logger (defaults to the process `log`);
                 multi-project sweeps (doAllDbs/doAll) inject a warn-floor
                 logger via sweepLogger() so routine per-plane INFO doesn't
                 clutter the progress bar - an explicit SBPERF_LOG_LEVEL wins.
                 bindProgress() lets the makeProgress bar and the logger
                 cooperate on a TTY: the sink erases the bar's un-terminated
                 line before each log line and repaints after, so WARN/ERROR
                 never smear the animation. A missing OPTIONAL relation/schema
                 (pg_cron/storage/auth on a DB that lacks it) is logged as a
                 debug "plane absent", not a warn - the collection note is still
                 recorded (folded into the sweep's per-project done() tail).
  transport.ts   Transport interface + DirectTransport (auth + retry)
  management.ts  typed, zod-parsed Management API wrapper (incl. diskAutoscale +
                 orgEntitlements for the disk over-provisioning context)
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
                 pg_stat_statements (by time + calls, WITH queryid for cross-
                 snapshot query identity that powers `diff`; PLUS queryIoStats -
                 per-query temp-file spill / disk-read miss / latency variance),
                 index-stats, bloat, extension inventory (+ pgvector ANN-index
                 health, pg_cron nudge), traffic-profile, threshold-aware vacuum,
                 txid wraparound, replication slots, role-stats, point-in-time
                 locks/blocking/long-running/idle-in-txn, cache-hit (volume-
                 gated) + stats-reset age, RLS audit, auth adoption (authAudit +
                 separate authMfa), pg_cron job-run health (cronJobs). Health-
                 check expansion (2026-07) added: checksumFailures
                 (pg_stat_database checksum corruption), walDirSize
                 (pg_ls_waldir, superuser), fkUnindexed (FK columns with no
                 covering index - leading-prefix check), invalidIndexes (failed
                 CONCURRENTLY builds), multixactWraparound (relminmxid's own 2B
                 ceiling, companion to txid), neverVacuumed (tables autovacuum
                 never touched), topByWal (pg_stat_statements.wal_bytes write-
                 amplification attribution), visibilityMap (relallvisible/relpages
                 index-only-scan readiness), publicSchemaCreate (PUBLIC CREATE on
                 schema public via aclexplode), and amcheck targets
                 (btreeIndexTargets + amcheckHeap, opt-in). The auth/
                 cron/queryIoStats queries run in BOTH modes (pure SQL) - part of
                 keeping no-PAT at feature parity with PAT. bloat carries a 10MB
                 table-size floor (the pg_stats estimator throws absurd bloat_x
                 on tiny tables - pure noise). biggestTables also returns
                 total_bytes/index_bytes (for storage attribution). bloatExact
                 (pgstattuple_approx) is EXACT reclaimable space, run only when
                 the extension is already installed + superuser SQL (collect.ts
                 gates it; sbperf never CREATEs an extension - that's a write);
                 findings prefer it over the estimate, else label the estimate.
                 tableIoStats (pg_statio_user_tables) is per-table IO
                 attribution - heap/idx/TOAST blocks read-from-disk vs cache-hit
                 ratios; sbperf-ORIGINAL (no upstream inspect equivalent), the
                 layer the GLOBAL cache-hit ratio lacks. A low toast_hit_pct +
                 high toast_blks_read is de-toasting an out-of-line column from
                 disk every scan (the large-blob / large-vector IO trap) ->
                 finding `toast_cache_cold`. biggestTables isolates toast_bytes
                 (pg_total_relation_size(reltoastrelid)) so a TOAST-dominated
                 table is visible. unindexedVectors carries dimension
                 (atttypmod) + storage strategy (attstorage) + an out_of_line
                 flag (EXTENDED vectors >~500 dims are TOASTed).
                 The app-object-inventory queries (index-stats, duplicate-
                 indexes, seq-scan-heavy, table-io-stats) exclude Postgres-
                 internal + Supabase-managed schemas IN SQL via `NON_APP_SCHEMAS_SQL` (appschema.ts,
                 the same denylist findings/narrate scope by), so a project with
                 many managed (e.g. `auth`) indexes can't crowd the user's own
                 out of the row cap - a real bug seen in the field: 27 auth + 3
                 public indexes hit the LIMIT 30 and hid 7 unused public indexes
                 the advisor did flag. rlsUnindexed deliberately does NOT exclude
                 `storage` (bucket-access RLS policies are user-authored).
  metrics.ts     Prometheus text parser + DISPLAY-only allowlist (collect
                 captures the FULL scrape; curate() only picks the HTML slice)
  collect.ts     orchestrate all planes -> validated Analysis (per-source errors
                 captured); captures the COMPLETE metrics corpus (all ~321
                 families, no curation) - the corpus is the product. Short-
                 circuits DB-dependent planes for a non-serving project: a PAT-
                 mode project whose status != ACTIVE_HEALTHY (paused/INACTIVE/
                 coming-up) has no live DB or metrics endpoint, so every SQL
                 query 544s (connection timeout) and metrics has no service_role.
                 dbServing (`!project || status==="ACTIVE_HEALTHY"`) gates all
                 SQL, the metrics scrape, and the five Management planes that
                 proxy live services (health/diskUtil/upgrade/sslEnforcement/
                 buckets, via `mgmtLive`), recording ONE `database` note instead
                 of ~24 per-plane warns (and dropping a ~16s run to ~2s). Static
                 platform-metadata planes (disk/pgConfig/pooler/backups/
                 authConfig/network-restrictions/functions/advisors/apiCounts)
                 still run - they work on a paused project. No-PAT superuser mode
                 keeps dbServing true (the --db-url points at a live DB). Also
                 fetches diskAutoscale (grow-only policy) + resolves the org
                 `instances.disk_modifications` entitlement (organizations() ->
                 slug -> orgEntitlements(); PAT-only, -> disk.modifiable), and
                 runs the opt-in amcheck integrity block (superuser + amcheck
                 installed): per-index bt_index_check (thrown error = corruption
                 hit) + optional verify_heapam under --amcheck heap.
  check.ts       CI gate: evaluateGate turns deriveFindings into a pass/fail by
                 severity (--fail-on), optional --category scope + --new-since
                 baseline (gate only on NEWLY-appeared findings). CLI exits 1 on
                 breach. Pure; reuses deriveFindings + diff so the gate sees
                 exactly what the report ranks.
  diff.ts        computeDiff(baseline, current): findings appeared/resolved/
                 severity-changed (keyed on a number-normalized title so a moved
                 value isn't a spurious resolve+appear pair) + query regressions
                 matched by pg_stat_statements queryid (>=1.5x mean-exec-time =
                 regression) + headline scalar deltas. renderDiffText for CLI.
  heuristics.ts  evergreen THRESHOLDS + per-finding metadata (whyItMatters,
                 howToVerify, remediation, optional sql, docUrl) attached to each
                 Finding by meta(); the deterministic report's what/why/how/verify.
  lints.ts       per-splinter-lint fix catalog keyed by bare lint name ->
                 {plainTitle, whatToDo, sql?, howToVerify}; makes advisor findings
                 a one-stop shop (concrete fix, not "go to the Advisor"). Kept in
                 sync with splinter.sql by scripts/check-lints-drift.ts.
  appschema.ts   isAppSchema()/appRows(): decides which schemas are the USER's
                 tables vs Postgres-internal / Supabase-managed. `NON_APP_SCHEMAS`
                 mirrors the exclusion set in splinter.sql's unused_index lint, so
                 findings.ts and the narrate digest scope index/RLS/vacuum signals
                 to the SAME objects the advisor does - never flagging a managed
                 index (e.g. `auth`), never missing a custom app schema (e.g.
                 `app1`). Replaced the old `schema==="public"` heuristic that
                 silently under-reported every project not living in `public`.
                 Fail-open (an unknown schema is treated as app). Drift-synced to
                 splinter.sql by scripts/check-schemas-drift.ts (superset
                 invariant: NON_APP_SCHEMAS must contain every schema splinter
                 excludes; extras are fine). Also exports `NON_APP_SCHEMAS_SQL`
                 (the denylist as a SQL `IN (...)` fragment) so the sql.ts
                 inventory queries apply the SAME scope server-side.
  (security)     collect also pulls three security-config Management planes -
                 config/auth (GoTrue: MFA/password/signup/anon/jwt_exp),
                 network-restrictions (DB IP allowlist), ssl-enforcement - into
                 analysis.security (null in no-PAT mode). findings.ts's
                 securityConfigFindings() turns these into sbperf-ORIGINAL
                 Security findings (network open to any IP, SSL off, email auto-
                 confirm, no MFA, weak password policy, anon sign-ins, long JWT) -
                 the first Security findings that aren't advisor-lint passthrough.
                 Field names verified against the live OpenAPI spec; endpoints
                 registered in check-api-drift.
  findings.ts    deriveFindings/derivePositives: the deterministic ranking pass.
                 Turns the raw Analysis (advisors + SQL + metrics + trends) into
                 ordered Finding[] (Performance/Security/Capacity, high/med/low)
                 and Positive[] ("what's looking good"), each enriched by meta()
                 from heuristics.ts. Includes the phase-2 tuning findings and the
                 TREND-DRIVEN capacity suggestions (disk/CPU/memory projections),
                 all data-aware via trendstats.sufficient() so a 2-point store
                 series never claims "sustained over 30d". Also: storage
                 attribution (largest table as a share of DB size, index-heavy
                 tables capped worst-first) so the disk story names its dominant
                 consumer; and a churn link - writeTargets() matches high-
                 frequency UPDATE/DELETE statements to a bloated/dead-tuple table
                 and annotates the bloat finding with the likely cause (e.g. a
                 hot counter update), the cross-cutting read the cards lack.
                 SQL-derived index/RLS findings + positives scope via appRows
                 (application schemas), NOT `public` only. The unused/duplicate
                 index SQL findings are FALLBACKS: suppressed when the advisor's
                 own `unused_index`/`duplicate_index` lint already fired (the
                 advisor's richer catalogued card wins), so the same objects are
                 never reported twice. The "No unused indexes" positive is
                 likewise gated on the advisor not having reported any. The
                 fk_unindexed finding is likewise suppressed when the advisor's
                 unindexed_foreign_keys lint fired. Health-check expansion
                 findings (2026-07): disk_oversized (over-provisioned volume
                 downsize candidate - the disk analogue of cpu_oversized, with
                 true-footprint = used minus reclaimable, gated on a min-waste
                 floor so tiny volumes never trip it; enriched with the
                 disk_modifications entitlement + grow-only autoscale note),
                 checksum_failure, index_corruption/heap_corruption (amcheck),
                 fk_unindexed, invalid_index, multixact_wraparound,
                 never_autovacuumed, wal_heavy_statement, visibility_map_low,
                 public_schema_create, plus configTuningFindings (a separate
                 exported fn) for the static GUC sanity set (work_mem blast,
                 timeouts, maintenance_work_mem RAM-relative, checkpoint
                 completion, track_io_timing). gucBytes() converts a pg_settings
                 value+unit to bytes for the memory-relative checks.
  trendstats.ts  trend-analysis primitives (slope/growth, sustained-fraction,
                 peak, linear projection) behind sufficient() gating; the shapes
                 the capacity findings + trend-health positives reason over.
  rls.ts         isUnwrappedAuth: flags an RLS policy that calls auth.uid()/
                 jwt()/role() WITHOUT a scalar sub-select wrapper (per-row re-eval
                 -> the 94-99% latency win from wrapping). Case-insensitive to
                 match how Postgres stores a wrapped policy back.
  report/render  Analysis -> self-contained HTML: a technical + business audit
                 pyramid (verdict + deterministic/LLM Executive summary ->
                 Resource snapshot 30-day charts -> What's looking good ->
                 Findings as What's happening/Why it matters/What to do (+SQL)/
                 How to verify -> Evidence drill-down). fillTrendsFromStore joins
                 the history store on every render path (report/pdf/emitReport).
                 The Resource snapshot labels its provenance via meta.trendSource
                 (prometheus/store/import - set by collect for Grafana, by
                 fillTrendsFromStore for the store, by import-trends) and, when
                 an infra source yields no EBS burst-balance panels, notes those
                 are CloudWatch-only (not on the metrics endpoint / store) so a
                 missing panel isn't misread as healthy.
                 render(a,{narrative}) embeds the narrative; renderNarrativePage
                 is the standalone narrative.html.
  extensions/    sbperf.pi.ts - pi tool wrapper (analyze/full/report/pdf/summary
                 + narrate_prompt/narrate_import copy-paste round-trip, pi as LLM).
  report/markdown minimal, HTML-escaping Markdown->HTML for the narrate subset
                 (headings/lists/bold/code/fenced/links); NOT a general parser
  brand.ts       report branding: Supabase default (official mark + green) +
                 loadBrand precedence (--brand > SBPERF_BRAND > ./sbperf.brand.json
                 > default); partial-override merge, logoPath/faviconPath inlined.
                 render(a,{brand}) / renderSummary/Index/NarrativePage(...,brand)
                 apply the favicon, header logo, and --accent/--link colours.
                 sbperf.brand.json is gitignored (keep the .example).
  overlay.ts     ref-keyed review overlay (hide drill sections + append markdown
                 notes), loaded with loadBrand-style precedence (--overlay >
                 SBPERF_OVERLAY > ./sbperf.overlays/<ref>.json >
                 ~/.sbperf/overlays/<ref>.json > empty) and merged at render
                 time via the drill() choke-point. Presentation-only: never
                 touches analysis.json or the narrate input. Hideable ids are
                 the drill() section ids. Overlays gitignored (keep .example).
  report/pdf     HTML -> PDF via headless Chromium --print-to-pdf (no Playwright
                 dep; system Chrome discovered on PATH or SBPERF_CHROME)
  narrate.ts     LLM pass over the corpus + enriched findings -> narrative.md.
                 Grounded: hands the model the ranked findings (with catalogued
                 remediation + doc URL), positives, and a BOUNDED evidence digest
                 (not the whole corpus); system prompt forbids inventing facts.
                 OpenAI-compatible client (OpenAI / local llama-server / ...),
                 injectable for tests; SBPERF_LLM_BASE_URL + _MODEL (+ _API_KEY).
                 buildNarrativeInput is the SOLE digest projection (feeds both
                 the direct-LLM path and the `narrate --print-prompt` pi round-
                 trip). Evidence carries: query outliers/frequent/IO, biggest
                 tables, NAMED unused indexes (unusedIndexesTop), dead-tuple /
                 autovacuum lag, per-table write profile, outdated extensions,
                 connections, roles, trends. Index/RLS/dead-tuple/write-profile
                 rows are scoped app-only (appRows / schema-prefix) - see the
                 Conventions note on why the digest is app-scoped while the
                 report shows all schemas.
  sync.ts        on-by-default soft-fail upstream sync check -> analysis.sync:
                 catalog vintage/age + vendored splinter.sql vs upstream hash;
                 rendered in the report footer. --no-sync-check to skip.
  store.ts       SQLite history store (bun:sqlite): `snapshot` appends full
                 Analysis + denormalized metric_samples/sql_scalars; keyed by
                 ref at ~/.sbperf/history.db; prune to retention
  trends.ts      pure computeTrends: gauges (1 pt/snapshot) + counter-derived
                 rates (CPU util %, IOPS, throughput) across >=2 snapshots, with
                 read-time downsampling to ~300 pts/panel (Grafana-style). The
                 query window is --trend-days (default 30; profile.trendDays wins)
                 and AUTO-SCOPES to a project's real data span so a young project
                 re-queries at its actual span instead of a mostly-empty 30d.
  prometheus.ts  optional trend panels pulled from a Prometheus/Grafana that
                 scrapes the metrics endpoint (--prometheus[-token|-cookie|
                 -matcher]); scoped to one project ref. Alternate trend source to
                 the store; `report` prefers --prometheus when both exist.
  profile.ts     --profile <file.json>: the whole no-PAT profile config in
                 one gitignored JSON (force-no-PAT + region-mapped Grafana creds,
                 per-region ALB cookie, + target databases). resolveGrafana maps
                 each project's region (from its connstring) to that region's
                 host/uid/cookie; full --profile sweeps databases[] via doAllDbs.
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
  endpoint wraps findings under `lints`, not `results`.) Corollary on
  optionality: an API field that is EXPLICITLY sent as `null` (not omitted)
  must be `.nullable()`, not just `.optional()` - `.optional()` alone rejects
  null and throws, which drops the WHOLE plane via `safe()`. E.g.
  `AuthConfig.password_required_characters` is null (not absent) when no
  character-class requirement is set; it was `.string().optional()` and
  silently lost every such project's GoTrue security findings until made
  `.string().nullable().optional()`. `.nullable()` here is the real shape, not
  papering over a mismatch - the field genuinely IS null.
- **App-schema scoping (`src/appschema.ts`), not `public`-only.** "Which schema
  is the user's?" is decided by `isAppSchema()`/`appRows()` - a denylist of
  Postgres-internal + Supabase-managed schemas mirrored from splinter.sql's
  `unused_index` lint - NOT by `schema === "public"`. The old public-only
  heuristic silently reported ZERO unused/duplicate/unindexed-RLS objects for
  any project that keeps its tables in a custom schema (e.g. `app1`), while the
  advisor path (splinter, schema-aware) correctly flagged them - the two
  diverged. `scripts/check-schemas-drift.ts` enforces a SUPERSET invariant
  (NON_APP_SCHEMAS must contain every schema splinter excludes; extra defensive
  entries are fine) so the denylist can't drift more-permissive than the
  advisor. When adding a schema-scoped signal, filter with `appRows` (or, when
  the row has only a qualified `schema.table` string and no schema column,
  `isAppSchema(table.split(".")[0])`).
- **Advisor findings are authoritative; the SQL-derived index findings are
  fallbacks.** deriveFindings suppresses the SQL `unused_index`/`duplicate_index`
  findings (and the "No unused indexes" positive) when the advisor's own lint of
  that name already fired - the advisor's catalogued card (plain title + concrete
  fix from lints.ts) is richer, and emitting both double-reports the same
  objects. The SQL path exists for when advisors are unavailable (hosted
  endpoint 400s AND no superuser --db-url to run splinter). Keep new
  SQL-vs-advisor overlaps mutually exclusive the same way (guard on the lint
  `name` present in `a.advisors.performance`).
- **The narrate digest is app-scoped; the report shows all schemas. This is
  deliberate - don't "fix" the inconsistency.** buildNarrativeInput scopes
  index/RLS/dead-tuple/write-profile evidence to application schemas; the report
  evidence tables render every schema. Different contracts: the report is the
  complete auditable record (a human reads `auth.sessions` bloat and knows it's
  Supabase's to manage), whereas the digest is the input to a RECOMMENDATION
  layer - feeding it managed-table internals invites the model to turn
  platform-internal state into a fake action item ("vacuum your refresh_tokens
  table") the user can't act on. If narrate ever becomes observability-
  description rather than advice, revert the scoping (one-liner per field); until
  then app-only is the correct default.
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
