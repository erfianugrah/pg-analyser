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

## Deferred (needs a precondition)
- Richer disk/IO beyond IOPS (latency, queue depth) - needs sustained scraper
  history to be meaningful.

## Optional (real gaps vs `supabase inspect report`, deliberately not done yet)
- Real bloat estimation (table + index wasted-bytes, pgstattuple-style). The CLI
  has it; sbperf has dead-tuple counts, which are related but not the same. The
  estimate is rough (statistics-based) - add if a reclaim decision needs it.
- traffic-profile (read-heavy vs write-heavy ratio per table). Niche; useful for
  architecture calls (partitioning, index strategy) but not a health signal.
