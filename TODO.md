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
- [x] txid-wraparound finding (age(relfrozenxid) vs 2B ceiling; from vacuum-stats)
- [x] replication-slot lag/inactive finding (inactive slot pins WAL = disk risk)
- [x] most-frequent-queries cut (pg_stat_statements by call count, noise-filtered)

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
  read-only SQL runner, so we curate our own query set instead. Trade-off:
  we must track upstream if they add a genuinely new perf command.

## Deferred (needs a precondition)
- Per-function invocation stats - no edge functions exist in the account to
  validate against; revisit when one does.
- Richer disk/IO beyond IOPS (latency, queue depth) - needs sustained scraper
  history to be meaningful.
