# TODO

## Done
- [x] PAT-only collector across Management API + read-only SQL + metrics
- [x] zod schemas at every boundary (advisors `lints` shape caught + fixed)
- [x] self-contained HTML report (utilitarian) + Chromium PDF
- [x] pyramid report: ranked findings summary + collapsible drill-downs
- [x] RLS policy audit (unwrapped auth), pg_settings config, noise filtering
- [x] degraded-state honesty for paused/unreachable projects
- [x] scrape-init: Prometheus+Grafana stack (validated live; named-volume fix)
- [x] full --all org iteration + index.html overview
- [x] --prometheus 30-day SVG trend panels (incl. disk read/write IOPS)
- [x] disk IOPS-headroom finding (latest rate vs provisioned)
- [x] edge-function + storage bucket coverage
- [x] full test suite + live smoke.ts + gated Live smoke workflow
- [x] txid-wraparound finding (age(relfrozenxid) vs 2B ceiling) - ORIGINAL: the
      CLI's vacuum-stats has no txid logic, `supabase inspect report` lacks this
- [x] replication-slot lag/inactive finding (inactive slot pins WAL = disk risk)
- [x] most-frequent-queries cut (pg_stat_statements by call count, noise-filtered)
- [x] threshold-aware autovacuum finding (dead tuples vs each table's actual
      autovacuum trigger; `overdue` flag - adapted from CLI vacuum-stats)
- [x] per-role connection usage vs limit + finding (from CLI role-stats)
- [x] stats-reset age surfaced (cache-hit/outliers are relative to this window)
      + index cache-hit ratio (from CLI db-stats)
- [x] per-function invocation stats (functions.combined-stats: requests, 5xx rate,
      exec time) + high-5xx finding (validated live against deployed functions)
- [x] C-suite summary tier: non-technical summary.html/pdf (verdict + plain-
      language findings + vitals), companion to the technical report
- [x] CI API-drift check: asserts every endpoint sbperf uses still exists in the
      upstream OpenAPI spec (api.supabase.com/api/v1-json); weekly cron + on push

## Deliberately not doing
- Gatekeeper transport - removed; direct (PAT) only.
- Remote push / running CI - staying local by choice; workflows remain for
  if that ever changes.
- locks / blocking / long-running-queries (from `supabase inspect db`) - these
  are point-in-time contention snapshots; near-useless in a static offline
  report (they'd need sampling *during* an incident). Deliberately skipped.
- Wrapping `supabase inspect report` - it dumps CSV of every inspect command
  (future-proof against new commands) but requires a DB connection string
  (--db-url / --linked = a password). sbperf's thesis is PAT-only via the
  read-only SQL runner, so we curate our own query set instead. The drift risk
  this creates is now covered by the CI API-drift check (scripts/check-api-
  drift.ts) against the upstream OpenAPI spec - no manual tracking, no CLI dep.

## SQLite-backed trends (done) - sbperf is its own collector
- [x] `snapshot` command: full collect -> append to a SQLite history store
      (`~/.sbperf/history.db`, keyed by ref), prune to --retention-days (default 90)
- [x] store.ts: HistoryStore (record/loadForTrends/snapshotCount/prune/latestAnalysis),
      full Analysis JSON retained + metric_samples/sql_scalars denormalized for cheap
      trend queries; ON DELETE CASCADE
- [x] trends.ts: pure computeTrends - gauges (one point/snapshot) + counter-derived
      rates (CPU util %, disk IOPS, disk/network throughput) across >=2 snapshots,
      counter-reset-safe
- [x] widened metrics allowlist to keep the counter families (node_cpu/disk/network)
      so rates are computable - a single scrape of a counter is meaningless
- [x] `report` fills trends from the store when no --prometheus trends are baked in;
      --prometheus stays as the alternate source and takes precedence
- [x] verified live end-to-end (example-project): 2 snapshots -> store (140 samples, both
      scalars) -> report renders all 13 trend series. Rapid back-to-back snapshots
      show 0 rates because Supabase's scrape interval is coarser than the gap
      (identical counters -> zero delta); hourly cron produces real rates.

WHY no API-only 30-day path: verified the metrics endpoint takes no time param
(point-in-time scrape) and the analytics endpoints cap ~24h. 30-day series MUST
be accumulated going forward - so sbperf accumulates it, no Prom/Grafana needed.

## Deferred (needs a precondition)
- Richer disk/IO beyond IOPS (latency, queue depth) - needs sustained snapshot
  history to be meaningful.

## Comprehensive inspect-parity (done)
- [x] full index-stats (all indexes by size + scans + unused flag; supersedes the
      bare unused-only list)
- [x] estimated bloat (pg_stats-based wasted-bytes) + reclaim finding (>=50MB)
- [x] traffic-profile (read-heavy vs write-heavy ratio per table)
- [x] point-in-time locks / blocking / long-running-queries as snapshot evidence;
      blocking + long-running fire findings when non-empty (real even as a
      snapshot), captioned as point-in-time. Reversed the earlier "skip" call now
      that coverage is the goal.

With these, sbperf collects a superset of the `supabase inspect` command set
(minus point-in-time semantics it can't have offline) plus advisors, metrics,
RLS audit, txid, and edge-function stats the CLI lacks.

## Shipped 2026-07-02 (superuser tier + advisor fallback + corpus)
- [x] complete metrics corpus at collection (all ~321 families, no curation);
      curate() is now DISPLAY-only. analysis.json + store hold everything.
- [x] render-time trend downsampling (~300 pts/panel, Grafana-style bucketing)
- [x] --interval analytics timeframe (15min|30min|1hr|3hr|1day|3day|7day)
- [x] --db-url superuser SQL tier (DirectSqlRunner/Bun.SQL), PAT stays default;
      connstring never written to analysis.json (only meta.sqlSource)
- [x] multiple DBs: repeatable --db-url + --db-config (gitignored), ref
      auto-derived from the connstring; `full` sweeps -> per-DB reports + index
- [x] export-prometheus: store -> OpenMetrics -> promtool backfill -> retroactive
      Grafana (verified vs prom/prometheus:v3.1.0)
- [x] self-hosted Performance Advisor: vendored splinter.sql run over --db-url
      (simple-query, multi-statement) as a fallback for the hosted
      advisors/performance 42601 bug (supabase/cli#4965). Recovered 10 lints on
      a project the hosted API returned 0 for.
- [x] RLS unwrapped-auth: capture qual/with_check, classify in tested JS
      (rls.ts) - fixed a case-sensitivity false-positive that flagged every
      correctly-wrapped policy.
- [x] convention: port checks from CLI/splinter source, stay API-first at runtime

## DONE 2026-07-03: inspect-SQL drift check (NOT verbatim vendoring)

Spike outcome: verbatim vendoring of the CLI inspect SQL is NOT achievable.
  1. The inspect queries use bind params (`WHERE nspname LIKE ANY($1)`, passed
     `LikeEscapeSchema(InternalSchemas)`). Our runners take a raw query string;
     the PAT read-only endpoint has no param binding at all -> the array must be
     inlined -> not verbatim.
  2. Our findings consume raw columns the CLI SQL wraps away, e.g. bloat needs
     `waste_bytes` (raw int) but the CLI returns only `pg_size_pretty(raw_waste)`
     -> we'd have to edit the vendored SQL -> not verbatim.
Every vendored query would carry a local delta, making a byte-diff drift check
fragile. So instead of re-vendoring, we KEEP our working/tested queries and add
an advisory drift check that warns when the UPSTREAM query changes (a re-review
nudge, not a runtime dependency). Gets the stay-synced benefit that motivated
the plan with near-zero churn; still guards the RLS-class silent-drift bug.

- [x] scripts/check-inspect-drift.ts: fetch upstream inspect *.sql (cli@develop),
      SHA-256 each, compare to scripts/inspect-baseline.json (14 queries mapped
      to their src/sql.ts key). Advisory (exit 0 + ::warning::); SBPERF_INSPECT_
      STRICT=1 to fail; SBPERF_INSPECT_UPDATE=1 to accept upstream after review.
- [x] pure classifyDrift() extracted + unit-tested (matching / drifted / missing /
      unfetchable). check:inspect wired into package.json + the CI api-drift job.
- [x] biome.json migrated (linter.rules.recommended -> preset, biome 2.5 dep).

### Superseded plan (kept for context): full vendor-with-delta

Shape:
```
src/inspect/*.sql   vendored verbatim (header: source path + upstream commit + date)
src/inspect/index.ts  name -> embedded SQL registry (Bun `with { type: text }`)
src/sql.ts            ONLY sbperf-original queries (txid, RLS audit, point-in-time
                      locks/blocking/long-running, threshold-aware vacuum, traffic)
scripts/check-inspect-drift.ts  diff vendored copies vs upstream, warn (like check:api)
```

Tasks (ordered; port opportunistically, do NOT big-bang overwrite working queries):
- [ ] SPIKE: fetch the CLI inspect dir, confirm the .sql format (Go-templated?
      param placeholders? multi-statement?). One query (bloat) end-to-end proves
      the vendoring + embed + column-map pattern before committing to all.
- [ ] vendor src/inspect/*.sql + registry; embed via text import (confirmed
      embeds in the compiled binary, like splinter.sql)
- [ ] MIGRATION per query: replace a hand-rolled sql.ts query with the vendored
      one; reconcile column names (alias in the vendored SQL OR remap
      render.ts/findings.ts + fixtures). FRICTION #1 = this remap churn.
- [ ] FRICTION #2: keep sbperf-original queries that beat the CLI's
      (threshold-aware vacuum, traffic-profile, point-in-time set). "Baseline
      from CLI" means where the CLI is canonical - don't regress improvements.
- [ ] scripts/check-inspect-drift.ts: fetch upstream inspect .sql, diff against
      vendored copies (ignore leading attribution comment), warn on drift. Wire
      into CI alongside check:api. Guards the sync.
- [ ] tests: each migrated query keeps/gets a fixture test; drift-check has a
      unit test (matching vs drifted).

Acceptance: sql.ts contains only original checks; every inspect-parity query is
vendored + drift-checked; report/findings unchanged in output (or improved);
full suite green. Effort ~1 focused day (mostly the column-remap churn).
