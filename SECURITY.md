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
- It never issues writes to your database. SQL runs read-only in PAT mode; in
  superuser mode the only state-changing calls are the opt-in
  `pg_stat_statements_reset()` (to window queries) and, under `--amcheck`, the
  read-only integrity checks - it never `CREATE`s an extension or alters data.

### Operator responsibilities

- Store the PAT and connstrings in your secret manager; pass them via env, not
  shell history.
- Treat generated reports as sensitive - they contain schema, query text, and
  table sizes. Do not commit them or paste them into untrusted channels.
- Scope PATs to the least privilege needed; rotate them if a report is shared.
