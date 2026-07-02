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

## Deliberately not doing
- Gatekeeper transport - removed; direct (PAT) only.
- Remote push / running CI - staying local by choice; workflows remain for
  if that ever changes.

## Deferred (needs a precondition)
- Per-function invocation stats - no edge functions exist in the account to
  validate against; revisit when one does.
- Richer disk/IO beyond IOPS (latency, queue depth) - needs sustained scraper
  history to be meaningful.
