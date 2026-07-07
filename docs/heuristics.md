# sbperf heuristics catalog

Evergreen performance/cost heuristics sbperf evaluates against a Supabase
project, grounded in Supabase maintainer guidance, the Postgres docs, and
production war stories. This is the source-of-truth reference; `src/heuristics.ts`
encodes the thresholds as typed data and `src/findings.ts` evaluates them.

## Why this exists

The example competitor/reference reports read as polished narratives because
each finding carries a threshold, an explanation, and a concrete fix. sbperf
already DETECTS most of these signals; this catalog makes the detection
- **grounded**: every threshold cites a maintainer/docs source, not a guess.
- **evergreen**: thresholds are stable Postgres/Supabase facts, dated so we know
  their vintage.
- **narratable**: each heuristic ships an `evidence` + `remediation` + `docUrl`
  so both the deterministic report and the LLM `narrate` pass are accurate.

## Provenance & the sync model

sbperf gets a large amount of upstream sync for FREE: the advisor lints
(`/advisors/{performance,security}`) are fetched LIVE via the Management API on
every run - those are Supabase's own evergreen heuristics, always current.

The heuristics in THIS file are the *supplement* - the compute/disk/memory/
realtime/auth planes the advisors do not cover. Those can go stale, so:

1. **Provenance is always shown** (no network): each heuristic carries a
   `reviewedDate`; the report footer states the vintage + notes advisor lints
   are live.
2. **CI drift check** (`scripts/check-inspect-drift.ts` family) fingerprints the
   upstream sources and warns when they move.
3. **Report-time sync check** (`src/sync.ts`, on by default; `--no-sync-check`
   to skip) soft-fails offline: it hashes the vendored advisor lint SQL
   (`src/splinter.sql`) against upstream `supabase/splinter` and reports the
   catalog vintage + age. It annotates staleness when it can reach upstream, and
   silently skips (with a note) when it cannot, so collection stays reproducible.
   The result is stored on `analysis.sync` and rendered in the report footer.

Catalog reviewed: **2026-07**. Thresholds below are stable facts; the review
date tracks when we last confirmed them against upstream.

## Legend

- **Severity**: `high` (act now / availability risk), `med` (address soon /
  clear waste), `low` (hygiene / informational).
- **Status**: `HAVE` (already in findings.ts), `NEW` (add), `PARTIAL` (detected
  but under-explained / needs enrichment).

---

## 1. Query & index performance (Postgres)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `seq_scan_heavy` | `pg_stat_user_tables` seq_scan >> idx_scan on a public table | seq-scan dominant | med | HAVE |
| `unused_index` | `pg_stat_user_indexes.idx_scan = 0`, non-constraint | idx_scan 0 | low | HAVE |
| `duplicate_index` | two indexes with identical column set on a table | any pair | med | HAVE |
| `top_time_query` | `pg_stat_statements` top by total_exec_time | >= 10% of DB time | med | PARTIAL |
| `functional_predicate` | WHERE wraps an indexed col in a function (e.g. `left(id::text,n)`) defeats the index -> seq scan | any on large table | med | NEW (best-effort; narrate diagnoses root cause) |
| `query_temp_spill` | a single query's `pg_stat_statements.temp_blks_written` (sorts/hashes spilling to disk) | >= `tempSpillBlocks` 12500 blks (~100MB) | med | HAVE |
| `query_high_variance` | a query's coefficient of variation (stddev/mean exec time), floored on mean | cv >= `queryCvWarn` 2 AND mean >= `queryCvMinMeanMs` 10ms | low | HAVE |

Notes:
- Duplicate indexes: each copy is maintained on every write for zero read
  benefit. Supabase advisor `duplicate_index` also flags these; the native check
  is a cheap, always-available cross-check. Drop one with
  `DROP INDEX CONCURRENTLY IF EXISTS ...` (no table lock).
- Functional-predicate is the `design_template_pages` class: `left(id::text, n)`
  in a WHERE stops the planner from using the PK index -> full scan. Fix: match
  on `id` directly, or add an expression index on `left(id::text, n)` if a prefix
  match is genuinely required. Deterministic detection is best-effort (parse
  `pg_stat_statements.query`); the LLM `narrate` pass explains the root cause.

Sources: Supabase Query Optimization docs; `supabase/cli` inspect queries.

---

## 2. RLS & security (Supabase + Postgres) - highest ROI plane

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `rls_initplan` | policy `USING/WITH CHECK` calls `auth.uid()`/`auth.jwt()`/`auth.role()`/`current_setting()` bare (not wrapped in a subselect) | any policy | med | HAVE |
| `rls_col_unindexed` | column compared in an RLS policy has no btree index | any RLS table | med | HAVE |
| `multiple_permissive_policies` | 2+ permissive policies for the same role + action on a table | any table | med | HAVE (via advisor) |
| `policy_exists_rls_disabled` | policy defined but RLS not enabled on the table | any | high | HAVE (via advisor) |
| `rls_no_role_target` | policy uses no `TO authenticated` (anon pays the RLS cost) | any | low | NEW |

Concrete numbers (Supabase RLS docs, official 100K-row test table):
- **Wrap `auth.uid()` in `(select auth.uid())`**: promotes the call to an
  InitPlan (once per query, cached) instead of once per row. Official test:
  `auth.uid() = user_id` 179ms -> `(select auth.uid()) = user_id` **9ms**.
  Supabase calls this "the single highest-impact change you can make to most
  policies." Advisor lint: `auth_rls_initplan`.
- **Index the policy column**: `(select auth.uid()) = user_id` only stays fast
  if `user_id` is indexed. Official test: 171ms -> **<0.1ms** with the index
  (>100x). Community benchmarks: unindexed RLS is 20-40x slower at 100K rows.
- **Multiple permissive policies compound**: Postgres runs EACH permissive
  policy for the same role+action on every row and ORs them. Consolidate into
  one policy combining conditions with OR.
- **Policy joins**: rewrite `auth.uid() in (select user_id from tm where
  tm.team_id = t.team_id)` (join per row) as `team_id in (select team_id from tm
  where user_id = (select auth.uid()))` (set lookup). Measured 380ms -> 22ms on
  a 200K-row table.
- **SECURITY DEFINER helper** breaks the RLS cascade/recursion when a policy
  reads another RLS-protected table. Keep it `LANGUAGE sql STABLE`, in a private
  schema, `SET search_path = ''`, `REVOKE EXECUTE` from anon/authenticated.
- **Add `TO authenticated`** so the `anon` role is excluded cheaply without
  running the rest of the policy.

Sources: Supabase RLS Performance & Best Practices docs; agent-skills
`security-rls-performance.md`; GaryAustin1/RLS-Performance benchmarks.

---

## Report display gating (presentation-only)

Point-in-time snapshot sections carry no signal at rest, so the report gates
them on data / thresholds rather than always rendering an empty or noise table
(the full corpus is always in `analysis.json` regardless):

- **Role connection usage** - shown only when a role reaches `roleConnShowFrac`
  (50%) of its limit (below the `role_conn_high` finding gate of 80%, so the
  table appears before saturation is critical).
- **Transaction-ID wraparound** - shown only when a table's `pct_wraparound`
  reaches `txidWarnPct` (20%).
- **Exclusive locks** - the query filters `locktype = 'relation'` + strong modes
  (AccessExclusive/Exclusive/ShareRowExclusive). The old `mode='ExclusiveLock'`-
  only form also matched the `virtualxid`/`transactionid` lock every backend
  (incl. sbperf's own diagnostic connections) holds, so it was never empty and
  showed the tool auditing itself. Section shown only when a real relation lock
  exists at collection.
- **Blocking chains / long-running queries / replication slots** - shown only
  when non-empty at collection.
- **API request volume** - rolled up to per-service totals + the peak bucket
  (the raw per-interval series is too granular).
- **Infra metrics** - a scrape-status line + link to the metrics guide, not the
  raw point-in-time table (a single scrape is not a trend).

All of the above are overridable by the review overlay (`overlay.ts`); the gates
only decide the default.

## 3. Connections & pooler (Supavisor / pgbouncer)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `direct_conn_high` | direct connections / `max_connections` | >= 70% | med | HAVE |
| `role_conn_high` | a role's connections / its `conn_limit` | >= 80% | med | HAVE |
| _(display)_ role-usage table shown | max role conn / limit >= `roleConnShowFrac` 50% | - | presentation gate |
| `pooler_clients_waiting` | `pgbouncer_pools_client_waiting_connections` | > 0 | med | HAVE |
| `connections_ceiling` | peak `pg_stat_database_num_backends` (trend) vs `max_connections` (pg_settings) | peak >= 80% of max | high | HAVE (trend) |
| `idle_in_txn_open` | a backend in `idle in transaction` at collection time (`pg_stat_activity` max state age) - pins locks + xmin horizon | >= `idleInTxnAgeS` 300s | med | HAVE |
| `txn_pooler_prepared_stmts` | txn-mode pool (port 6543) + prepared statements | pool_mode=transaction | low | NEW (informational) |

Notes:
- Transaction mode (6543) does NOT support prepared statements; session mode
  (5432) does. Symptom: `prepared statement "..." does not exist` / `already
  exists`. Fix: `pgbouncer=true` (Prisma) / `prepare:false` / statement cache 0
  (asyncpg/SQLAlchemy). "Max client connections reached" = exceeded the pool
  limit for the compute add-on.
- Serverless: transaction mode + `connection_limit=1`, scale cautiously.

Sources: Supabase Supavisor docs; Prisma troubleshooting docs; supavisor FAQ;
supabase/supabase#39227, supavisor#595 (connection leak).

---

## 4. Vacuum, bloat & transaction-ID wraparound (Postgres)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `autovacuum_overdue` | dead tuples past the per-table autovacuum trigger | overdue | med | HAVE |
| `dead_tuple_ratio` | `n_dead_tup` vs `n_live_tup` | dead >= ~2x live -> AV not keeping up | med | PARTIAL |
| `table_bloat` | reclaimable waste bytes (estimate) | >= 50MB (med >= 500MB) | low/med | HAVE |
| `txid_wraparound` | `age(relfrozenxid)` toward the 2B ceiling | >= 20% (high >= 40%) | med/high | HAVE |
| `xmin_horizon_pin` | a long-running / idle-in-txn session pins the xmin horizon, blocking vacuum | any + rising dead tuples | high | NEW |

Concrete facts:
- Supabase's own heuristic: if live vs dead differ by **more than 2x**, autovacuum
  likely did not start or did not complete. Default `autovacuum_vacuum_scale_
  factor` is 20% - too high for big tables; lower per-table to 0.05.
- XIDs are 32-bit (~4.2B space, ~2.1B usable). Near **2B unfrozen**, Postgres
  HALTS new writes to prevent corruption. The anti-wraparound autovacuum canNOT
  be terminated (`must be a superuser to terminate superuser process`) and drives
  CPU + disk I/O to ~100% until done.
- The most common reason autovacuum can't succeed: a long-running or idle-in-
  transaction session pins `oldest xmin`, so dead tuples can't be removed and
  bloat + XID age climb together. Watch `pg_stat_activity` for old
  `xact_start` / `idle in transaction`. sbperf already flags
  `idle_in_transaction_session_timeout = 0` and long-running queries; the NEW
  check correlates "old txn present AND dead tuples rising" into one finding.
- Bloat reclaim: `pg_repack` rebuilds online (brief final lock); `VACUUM FULL`
  needs an exclusive lock the whole time. War story: at high XID age the anti-
  wraparound AV blocks pg_repack's final ACCESS EXCLUSIVE swap - be ready to
  kill AV during the swap.

Sources: Supabase Postgres Bloat blog; Supabase high-CPU-autovacuum
troubleshooting; PG docs (routine vacuuming); trigger.dev xmin-horizon
war story; dev.to 2B-XID war story; AWS XID-wraparound blog.

---

## 5. Compute (CPU & memory)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `cpu_saturated` | sustained CPU-util fraction (trend; `sufficient()`-gated: >=12 pts over >=3d) | >=50% of window at >=80% util | high | HAVE (trend) |
| `cpu_oversized` | low CPU-util p95 over a long window (downsize candidate) | p95 <= 20% over >=14d | low | HAVE (trend) |
| `mem_saturated` | sustained memory-used% fraction (trend) | >=30% of window at >=85% | med | HAVE (trend) |
| `load_high` | `node_load1/5/15` vs vCPU count | load1 > vCPUs | med | NEW |
| `mem_pressure` | `node_memory_MemAvailable_bytes / MemTotal` | avail < ~10% | med | NEW |
| `mem_pressure_paging` | sustained `node_vmstat_pgmajfault` / `pswpin` rate (needs >=2 snapshots / a Prometheus) | major faults >= 20/s OR swap-in >= 2 pages/s | med | HAVE (trend) |
| `psi_saturation` | sustained `node_pressure_{cpu,memory,io}_waiting_seconds_total` rate as a stall % (needs >=2 snapshots / a Prometheus) | sustained stall >= 20% on any resource | med | HAVE (trend) |
| `oom_kill` | `node_vmstat_oom_kill` rate | any nonzero over the window | high | HAVE (trend) |

Notes:
- **No swap-OCCUPANCY finding (deliberate).** Swap is tiny (~1GB) and the kernel
  parks cold anon pages there, so a full-but-idle swap is normal/healthy. The
  real memory-pressure signal is the RATE - a sustained swap-IN or major-fault
  rate means the working set is spilling out of RAM to disk. That is
  `mem_pressure_paging`, and it needs time series - both a MemAvailable snapshot
  and the coarse project status can read healthy while a small instance pages
  its working set to disk.
- Compute sizes Nano..2XL can BURST CPU; Large and above have predictable (no
  burst) performance. High mem -> swapping -> disk I/O (each project has 1GB
  swap). Cache-as-memory is healthy; swap is not.
- Memory config sanity (see section 7) often explains mem pressure before a
  compute upgrade is warranted - assess software-constrained vs hardware-
  constrained first.

Sources: Supabase Compute & Disk docs; Supabase High Disk I/O docs.

---

## 6. Storage & disk I/O

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `disk_full` | used / (used+avail) | >= 80% | med | HAVE |
| `disk_iops_high` | derived read+write IOPS / provisioned | >= 80% | med | HAVE (trend) |
| `disk_throughput_high` | derived MB/s / provisioned | >= 80% | med | NEW (trend) |
| `disk_io_budget_depleted` | small instance bursting then throttled to baseline | sustained at baseline under load | med | NEW |
| `ebs_balance_low` | `aws_ec2_ebsiobalance_percent_minimum` / `aws_ec2_ebsbyte_balance_percent_minimum` (CloudWatch-backed source only) | worst point <= 20% | high | HAVE (trend) |
| `disk_fill_projection` | rising disk-used% slope projected to 100% (trend; horizon capped to ~3x observed span so a short history can't claim a far-future date) | on track to full within <=120d | high/med | HAVE (trend) |
| `wal_retained_inactive_slot` | inactive replication slot retaining WAL | any | high | HAVE |
| `wal_slot_lag` | active slot retained WAL | >= 1GB | med | HAVE |
| `wal_archival_backlog` | `pg_ls_archive_statusdir_wal_pending_count` (trend) | sustained avg >= 1 pending | high | HAVE (trend) |

Per-compute disk limits (Supabase Compute & Disk docs; gp3 default 3,000 IOPS /
125 MB/s baseline; effective = min(compute-supported, provisioned-disk)):

| compute | baseline IOPS | max IOPS | baseline MB/s | max MB/s |
|---|---|---|---|---|
| Nano | 250 | 11,800 | 5 | 261 |
| Micro | 500 | 11,800 | 11 | 261 |
| Small | 1,000 | 11,800 | 22 | 261 |
| Medium | 2,000 | 11,800 | 43 | 261 |
| Large | 3,600 | 20,000 | 79 | 594 |
| XL | 6,000 | 20,000 | 149 | 594 |
| 2XL | 12,000 | 20,000 | 297 | 594 |
| 4XL | 20,000 | 20,000 | 594 | 594 |
| 8XL | 40,000 | 40,000 | 1,188 | 1,188 |
| 12XL | 50,000 | 50,000 | 1,781 | 1,781 |
| 16XL | 80,000 | 80,000 | 2,375 | 2,375 |

Notes:
- Disk IO Budget: Nano..Medium burst above baseline for a while, then throttle
  to baseline once the budget is spent -> response times up, CPU up (IO wait),
  autovacuum/backups disrupted, instance may become unresponsive. Larger compute
  (4XL+) has consistent disk performance.
- Cloud limits disk modifications to ~4 in a rolling 24h window.

Sources: Supabase Compute & Disk docs; Manage Disk IOPS / Throughput usage docs;
High Disk I/O troubleshooting.

---

## 7. Postgres config & memory tuning

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `cache_hit_low` | `blks_hit / (blks_hit + blks_read)` | < 99% | med | HAVE |
| `idle_in_txn_timeout_off` | `idle_in_transaction_session_timeout = 0` | =0 | low | HAVE |
| `statement_timeout_off` | `statement_timeout = 0` | =0 | low | HAVE |
| `work_mem_spill` | `pg_stat_database_temp_bytes_total` rising (sorts/hashes spill to disk) | rate >= 1MB/s (trend) | med | HAVE |
| `checkpoint_pressure` | `pg_stat_bgwriter_checkpoints_req_total` vs `_timed_total` rate (trend) | requested >= 30% of checkpoints -> raise max_wal_size | med | HAVE (trend) |
| `shared_buffers_ratio` | `shared_buffers` vs RAM | not ~25% (warn > 40%) | low | NEW |
| `deadlocks` | `pg_stat_database_deadlocks_total` | >= 5 cumulative | low | HAVE |

Config guidance (general Postgres tuning; Supabase sets sane defaults per
compute tier, so treat these as sanity checks, not prescriptions):
- `shared_buffers` ~25% RAM, do not exceed ~40% (starves OS cache).
- `effective_cache_size` ~50-75% RAM (planner hint; does not allocate).
- `work_mem`: too low -> sorts/hash joins spill to disk (temp files); too high x
  many connections -> OOM. Rough ceiling: `max_connections * (1-2MB + work_mem)`.
  Tune per-session for heavy queries rather than globally. Concrete starting
  point when spilling: bump the offending role/session toward `16MB`-`64MB`.
- `statement_timeout`: Supabase ships per-role defaults (`anon` 3s,
  `authenticated` 8s; `postgres`/custom roles only bounded by the 2min global
  cap). A global `0` therefore leaves postgres/custom roles uncapped. Set an
  explicit cap: interactive/API roles `30s`-`60s`, analytics/batch `2min`-`5min`
  (source: Supabase timeouts guide).
- `idle_in_transaction_session_timeout`: default `2min` for most roles,
  `5min`-`10min` for long batch/ETL roles; stops abandoned txns pinning xmin.
- `maintenance_work_mem`: low -> slow `CREATE INDEX` / `VACUUM`.
- Cache-hit target > 99%; below that, requests hit disk (raise via more RAM /
  better indexing, not just shared_buffers).

Sources: Supabase High Disk I/O (cache) docs; general PG memory/connection
tuning references.

---

## 8. Auth (GoTrue)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `auth_rate_limited` | 429s on `/auth/v1/*` (token bucket, cap 30) | any sustained | med | NEW |
| `auth_5xx` | 500 on `/auth/v1/*` (usually a DB trigger/function on `auth.users`) | any | high | NEW |
| `auth_email_default_smtp` | built-in email provider (2 emails/hr cap) | using default SMTP | low | NEW (config) |
| `auth_email_autoconfirm` | GoTrue `mailer_autoconfirm = true` (signups auto-confirmed without verifying the address) | enabled | med | HAVE |
| `auth_mfa_disabled` | no `mfa_*_verify_enabled` factor enabled project-wide (fields present) | none enabled | low | HAVE |
| `auth_weak_password_policy` | `password_min_length < 8` OR `password_hibp_enabled = false` | len < `passwordMinLength` 8 (med) / HIBP off (low) | med/low | HAVE |
| `auth_anonymous_users` | `external_anonymous_users_enabled = true` (awareness - confirm RLS + rate limits) | enabled | low | HAVE |
| `auth_long_jwt` | access-token TTL `jwt_exp` above the 1h default | > `jwtExpMaxSec` 3600s | low | HAVE |

Rate-limit quotas (Supabase Auth rate-limit docs; token-bucket cap 30, per IP
unless noted; some customizable in Authentication > Rate Limits):
- Token refresh `/auth/v1/token`: **1800/hr per IP**.
- Verify `/auth/v1/verify`: **360/hr per IP**.
- OTP send: 30/hr project-wide (customizable); 60s window per user.
- Email sends (signup/recover/user): built-in SMTP only **2 emails/hr** - a
  custom SMTP provider is required to raise it.
- MFA challenge/verify: 15/hr per IP. Anonymous sign-ins: 30/hr per IP.

Status codes: 429 = rate-limited (handle with exponential backoff; `conflict`
often means too many concurrent refreshes); 500 = auth server degraded, most
often a misbehaving trigger/function/view on the `auth` schema. Behind a proxy,
set `Sb-Forwarded-For` so rate limiting keys on the end-user IP, not the server.
JWT signing keys let you validate JWTs in-app (offload GoTrue user lookup;
reported 15ms -> <2ms per authenticated request).

Sources: Supabase Auth Rate Limits docs; Auth Error Codes docs; Supabase JWT
Signing Keys.

---

## 9. Realtime

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `realtime_conns_near_limit` | concurrent connections vs plan cap | >= 80% | med | NEW |
| `realtime_msgs_near_limit` | messages/sec vs plan cap | >= 80% | med | NEW |
| `realtime_channels_per_conn` | channels on one connection | >= 80 (cap 100) | low | NEW |
| `realtime_postgres_changes` | `realtime_postgres_changes_total_subscriptions` > 0 | any at scale | low | HAVE (nudge) |

Plan caps (Supabase Realtime Limits docs):

| plan | concurrent conns | msgs/sec | channel joins/sec | channels/conn |
|---|---|---|---|---|
| Free | 200 | 100 | 100 | 100 |
| Pro | 500 | 500 | 500 | 100 |
| Pro (no cap) / Team | 10,000 | 2,500 | 2,500 | 100 |

Limit-breach WebSocket errors: `too_many_connections`, `too_many_channels`,
`too_many_joins`, `tenant_events` (msgs/sec exceeded -> disconnect + auto-
reconnect when throughput drops). Postgres-changes payload > limit truncates to
fields <= 64 bytes.

Broadcast vs Postgres Changes: Supabase recommends **Broadcast** for scale/
security; `postgres_changes` acquires a logical replication slot and polls it,
appending subscription IDs per WAL record - it does NOT scale as well. A high
`realtime_postgres_changes_total_subscriptions` on a busy project is a nudge to
migrate to `realtime.broadcast_changes()` triggers. Note: `postgres_changes`
also runs your RLS policies for authorization, so section 2 applies here too.

Sources: Supabase Realtime Limits / Subscribing to DB Changes / Architecture
docs.

---

## 10. Edge Functions

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `fn_5xx` | serverErr / requests per function | >= 10% (high >= 20%) | med/high | HAVE |
| `fn_cold_start` | invocation wall time / cold-start latency | > 500ms cold | low | NEW (if signal available) |
| `fn_client_err` | clientErr / requests (4xx - app bug or bad input) | >= 20% | low | NEW |

Notes: cold start > 500ms suggests insufficient warm workers. Track p95 latency
> 1s and error rate > 1% as SLA triggers. Signals come from
`functions.combined-stats` (already aggregated per function in collect.ts:
requests/success/clientErr/serverErr/avg/max exec ms).

Sources: production war stories; Supabase system-design best-practices.

---

## 11. PostgREST / Storage / Backups

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `pg_update_available` | `current_app_version != latest_app_version` | mismatch | low | HAVE |
| `pitr_absent` | no-PAT + superuser sees no live WAL archiving (`archive_mode` off, or on with `archived_count = 0`); gated to no-PAT so it never contradicts `backups.pitr_enabled` | not archiving | low | HAVE |
| `storage_bucket_public` | a bucket is public | any (security note, cross-ref advisor) | low | NEW (informational) |

Notes: PITR / backup posture and public-bucket exposure are informational
hygiene, not perf - surfaced low-severity so the "what to check" story is
complete without alarming.

Sources: Supabase Backups / Storage docs; live advisors for the security angle.

---

## 12. Security configuration (network / SSL / pg_hba)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `network_restrictions_open` | `dbAllowedCidrs`/`dbAllowedCidrsV6` empty or contains `0.0.0.0/0` or `::/0` (Postgres port reachable from any IP) | no allowlist or open CIDR | med | HAVE |
| `ssl_not_enforced` | `sslEnforcement.currentConfig.database = false` (server accepts unencrypted connections) | SSL enforcement off | med | HAVE |
| `hba_weak_auth` | `pg_hba_file_rules` trust/password/ident rule for a non-loopback, non-replication address (superuser --db-url only) | any such rule | med | HAVE |

These are sbperf-ORIGINAL Security findings derived from Management-API config
planes (network-restrictions, ssl-enforcement) plus a superuser `pg_hba_file_rules`
check - not advisor-lint passthrough. `hba_weak_auth` needs a TRUE superuser
(`supabase_admin`) and fires only on a real auth bypass (a non-`scram-sha-256`
rule from a non-loopback address), NOT on host-vs-hostssl (Supabase terminates
TLS at the proxy, so its standard pg_hba is all `host ... scram-sha-256`).
The `hbaRules` query is only ATTEMPTED on the superuser SQL tier
(`runner.source === "superuser"` in collect.ts): the PAT read-only user is
always denied `pg_hba_file_rules` (42501), so PAT-mode audits skip it silently
rather than logging a warn+note per run. Present whenever a superuser --db-url
is (no-PAT or PAT+--db-url).

Sources: Supabase Network Restrictions / SSL Enforcement docs; PG docs pg_hba.conf.

---

## 13. Extensions & scheduled jobs (pgvector, pg_cron)

| id | signal | threshold | sev | status |
|---|---|---|---|---|
| `pgvector_unindexed` | a `vector` column with no ANN (ivfflat/hnsw) index | any | med | HAVE |
| `extensions_outdated` | installed extension behind `pg_available_extensions.default_version` | any | low | HAVE |
| `cron_job_failing` | `cron.job_run_details` failed runs in the last 7 days | failed_runs > 0 | med | HAVE |
| `pg_cron_review` | pg_cron installed but no run-detail visibility (fallback nudge) | pg_cron present + 0 cron jobs seen | low | HAVE |

Notes: the pg_cron plane is the ETL/automation health the advisor can't see; a
failed scheduled job is a real (often silent) outage. pgvector without an ANN
index forces an exact full scan on every similarity search. Both run as pure SQL,
so they work in no-PAT mode too. A missing `cron.*` schema is an expected absence
(logged debug "plane absent", not a warn) on a DB without pg_cron.

Sources: Supabase pgvector / AI & Vectors docs; pg_cron docs; supabase/cli
inspect SQL.

---

## Cross-cutting: severity & narration contract

Each heuristic in `src/heuristics.ts` carries: `id`, `plane`, `severity` (or a
function of the measured value), `title(ctx)`, `evidence(ctx)`, `remediation`,
`docUrl`, `reviewedDate`. `deriveFindings` attaches these to every `Finding` so:
- the deterministic report can show what/why/how inline (no LLM),
- the `narrate` LLM pass has grounded, cited facts to synthesize from (it must
  not invent thresholds - it cites these),
- the sync check can report each heuristic's `reviewedDate` vintage.

## Source index

- Supabase RLS Performance & Best Practices; Row Level Security; Query
  Optimization; Database Advisors.
- Supabase Compute & Disk; Manage Disk IOPS / Disk Throughput usage; High Disk
  I/O troubleshooting.
- Supabase Supavisor; Prisma troubleshooting; supavisor FAQ.
- Supabase Postgres Bloat (blog); High-CPU autovacuum troubleshooting; PG docs
  routine vacuuming.
- Supabase Auth Rate Limits; Auth Error Codes; JWT Signing Keys.
- Supabase Realtime Limits / Subscribing to DB Changes / Architecture.
- Supabase Network Restrictions / SSL Enforcement; PG docs pg_hba.conf.
- Supabase AI & Vectors (pgvector); pg_cron docs; Supabase Cron.
- Supabase GoTrue auth config (MFA / password policy / anonymous sign-ins / JWT).
- supabase/cli inspect SQL (github.com/supabase/cli apps/cli-go/internal/inspect);
  supabase/splinter (vendored splinter.sql).
- War stories: trigger.dev xmin-horizon; dev.to 2B-XID; GaryAustin1/RLS-
  Performance; supabase/supabase#39227.
