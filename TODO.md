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

## Next
- [ ] gatekeeper-transport live smoke once a narrow key is provisioned (set repo secrets, run the Live smoke workflow)
- [ ] richer disk/IO analysis (IOPS headroom vs node_disk_* rates from the scraper)
- [ ] optional `--prometheus <url>` on `report` to embed real 30-day panels if a scraper exists
- [ ] edge-function stats (needs per-function_id) + storage bucket sizes
- [ ] `full --all` to iterate every project in an org
- [ ] CI: typecheck + lint + test on push
- [ ] `bun run build` binary release via GH Actions
