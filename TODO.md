# TODO

## Done
- [x] PAT-only collector across Management API + read-only SQL + metrics
- [x] direct + gatekeeper transports
- [x] zod schemas at every boundary (advisors `lints` shape caught + fixed)
- [x] self-contained HTML report (utilitarian) + Playwright PDF
- [x] scrape-init: Prometheus+Grafana stack for going-forward 30-day history
- [x] tests: prometheus parser, render, empty-states, tag balance
- [x] full unit suite (config, schemas, transport, management, collect, scraper, sql) - 55 tests
- [x] live `smoke.ts` (all planes) + gated Live smoke CI workflow

- [x] `full --all` org iteration + index.html overview
- [x] `--prometheus <url>` 30-day trend panels (inline SVG sparklines)
- [x] edge-function + storage bucket coverage
- [x] scraper stack validated end-to-end (fixed host-uid crash with named volumes)

## Next
- [ ] gatekeeper-transport live smoke once a narrow key is provisioned (parked)
- [ ] richer disk/IO analysis (IOPS headroom vs node_disk_* rates from the scraper)
- [ ] per-function invocation stats (needs function_id + analytics endpoint)
- [ ] push to a remote so CI/release workflows actually run
