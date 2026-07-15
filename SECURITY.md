# Security

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories:
**Security -> Report a vulnerability** on this repository. Do not open a public
issue for anything security-sensitive. I aim to acknowledge reports within a
few days.

## Threat model

sbperf is a local CLI that reads from a Supabase project and renders a report.
It handles several secrets; understanding where they flow is the core of the
threat model.

### Secret surface

- **Personal Access Token (PAT)** - `SUPABASE_ACCESS_TOKEN`, or read from
  `~/.supabase/access-token`. Grants Management API + read-only SQL access to
  your projects.
- **Superuser connection string** (`--db-url` / `SBPERF_DB_URL` /
  `sbperf.databases.json`) - full Postgres access. The most sensitive input.
- **Auto-fetched `service_role` key** - resolved per run via the Management API
  to scrape the metrics endpoint. Never written to disk.
- **Grafana session cookie** (`--prometheus-cookie` / profile JSON) - per-region
  dashboard access for trend backfill.

### Handling guarantees

- **Connection strings are never persisted.** `analysis.json` records only
  `meta.sqlSource` (the tier: `read-only` / `superuser`), never the connstring.
- **The `service_role` key is never written** - it lives in memory for the
  duration of the metrics scrape and is discarded.
- **Generated reports contain live query text** and are gitignored (`reports/`).
- **Secret-bearing config is gitignored**: `.env*` (except `.env.example`),
  `sbperf.databases.json` and numbered variants, `sbperf.profile.json` /
  `sbperf.*.profile.json`, `sbperf.brand.json`, `sbperf.overlays/`, and the
  `scraper/` scratch dir (its generated `prometheus.yml` embeds a credential).
  Keep the committed `.example` files placeholder-only.

### What sbperf does NOT do

- It does not exfiltrate data anywhere. All network calls go to
  `api.supabase.com`, the `<ref>.supabase.co` metrics endpoint, your own
  `--db-url`, and (optionally) a Grafana/Prometheus you point it at.
- It never issues writes to your database. Every diagnostic query is a
  `SELECT`/CTE (enforced by a test over the whole query set); the only
  non-SELECT statements it sends are session `SET statement_timeout` /
  `SET lock_timeout` guards. It never `INSERT`/`UPDATE`/`DELETE`s, never runs
  DDL, never `CREATE`s an extension, and does not reset your query statistics.

### How sbperf protects the target database

sbperf is designed to be safe to run against a live production primary:

- **Bounded runtime.** The superuser runner prepends `statement_timeout`
  (default 120s) and `lock_timeout` (default 15s) to *every* query, sent in the
  same message so they bind to the same pooled backend. No diagnostic can run
  unbounded. Override with `SBPERF_STATEMENT_TIMEOUT` / `SBPERF_LOCK_TIMEOUT`
  (`0` disables a cap).
- **Read-only, non-blocking locks.** Being SELECT-only, sbperf takes only
  `AccessShareLock`, which does not block reads or writes; `lock_timeout` makes
  it fail fast rather than queue behind someone's `ALTER`.
- **Heavy checks are opt-in and gated.** The integrity checks
  (`bt_index_check`, `verify_heapam`) run only under `--amcheck` and only when
  the `amcheck` extension is already installed; exact bloat (`pgstattuple`) runs
  only when that extension is already installed. amcheck additionally bounds
  each index check separately (`SBPERF_AMCHECK_TIMEOUT`, default 300s) and
  records a timeout as a skip, not a corruption result.
- **Connection-frugal.** The pool is capped at 2 connections
  (`prepare:false, max:2`) so an audit cannot exhaust connection slots.

### Operator responsibilities

- Store the PAT and connstrings in your secret manager; pass them via env, not
  shell history.
- Treat generated reports as sensitive - they contain schema, query text, and
  table sizes. Do not commit them or paste them into untrusted channels.
- Scope PATs to the least privilege needed; rotate them if a report is shared.
