/**
 * The perf diagnostic query set. Sourced from the Supabase Postgres
 * best-practices `monitor-` rules and the Supabase RLS performance guide.
 *
 * All read-only, run via the Management API read-only SQL runner (as
 * supabase_read_only_user). pg_stat_statements lives in the `extensions`
 * schema on Supabase.
 */

// Platform / Studio / introspection queries that swamp pg_stat_statements but
// are not the user's workload. Excluded from the outliers view (footnoted).
const PLATFORM_NOISE = [
  "%pg_timezone_names%",
  "%pg_available_extensions%",
  "%pgbouncer%",
  "%pg_backup_%",
  "%pg_stat_statements%",
  "%information_schema%",
  "%pg_class%",
  "%pg_namespace%",
  "%pg_attribute%",
  "%pg_proc%",
  "%pg_catalog%",
  "%pg_get_%",
]
  .map((p) => `'${p}'`)
  .join(",");

export const QUERIES = {
  dbSize: /* sql */ `
    select pg_size_pretty(pg_database_size(current_database())) as db_size`,

  // Table + index cache-hit ratio. Only meaningful relative to how long stats
  // have accumulated (see statsResetAge) - a fresh reset shows a misleading 100%.
  cacheHit: /* sql */ `
    select
      round(sum(heap_blks_hit) * 100.0
        / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2) as cache_hit_pct,
      (select round(sum(idx_blks_hit) * 100.0
        / nullif(sum(idx_blks_hit + idx_blks_read), 0), 2)
       from pg_statio_user_indexes) as index_hit_pct
    from pg_statio_user_tables`,

  // How long pg_stat_statements has been accumulating. Cache-hit % and the
  // outliers/calls views are only interpretable against this window.
  statsResetAge: /* sql */ `
    select (now() - stats_reset)::text as stats_age
    from extensions.pg_stat_statements_info`,

  // Perf-relevant server settings - the API config endpoint returns {} on many
  // projects, so read them from pg_settings directly.
  pgSettings: /* sql */ `
    select name, setting, unit
    from pg_settings
    where name in (
      'max_connections', 'shared_buffers', 'effective_cache_size', 'work_mem',
      'maintenance_work_mem', 'statement_timeout', 'lock_timeout',
      'idle_in_transaction_session_timeout', 'random_page_cost',
      'max_parallel_workers'
    )
    order by name`,

  // App workload only - platform/introspection noise filtered out.
  topStatements: /* sql */ `
    select
      round(total_exec_time::numeric, 1) as total_ms,
      calls,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1) as pct,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
    order by total_exec_time desc
    limit 20`,

  // Same workload, ranked by call count - surfaces chatty N+1 / hot-path
  // statements that are individually cheap but dominate round-trips.
  topByCalls: /* sql */ `
    select
      calls,
      round(total_exec_time::numeric, 1) as total_ms,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * calls / nullif(sum(calls) over (), 0))::numeric, 1) as pct_calls,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
    order by calls desc
    limit 20`,

  biggestTables: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size,
      pg_size_pretty(pg_indexes_size(relid)) as index_size,
      n_live_tup as live_rows
    from pg_stat_user_tables
    order by pg_total_relation_size(relid) desc
    limit 20`,

  unusedIndexes: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      indexrelname as index,
      pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
      idx_scan as scans
    from pg_stat_user_indexes
    where idx_scan = 0
      and indexrelid not in (select conindid from pg_constraint where contype in ('p', 'u'))
    order by pg_relation_size(indexrelid) desc
    limit 30`,

  seqScanHeavy: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      seq_scan,
      idx_scan,
      n_live_tup as live_rows,
      case when seq_scan > 0
        then round((seq_scan::numeric / nullif(seq_scan + idx_scan, 0)) * 100, 1)
        else 0 end as seq_scan_pct
    from pg_stat_user_tables
    where seq_scan > coalesce(idx_scan, 0)
      and n_live_tup > 1000
    order by seq_scan desc
    limit 20`,

  // Autovacuum-behind, threshold-aware. Rather than a fixed dead-tuple cutoff,
  // compute each table's actual autovacuum trigger (per-table reloptions, else
  // the cluster default) and flag tables whose dead tuples already exceed it
  // (`overdue` = autovacuum is due but hasn't caught up). Adapted from the
  // Supabase CLI's vacuum-stats inspect query.
  deadTuples: /* sql */ `
    with opts as (
      select c.oid, c.relname, n.nspname,
        array_to_string(c.reloptions, '') as relopts,
        c.reltuples, s.n_live_tup, s.n_dead_tup, s.last_autovacuum
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname not in ('pg_catalog', 'information_schema')
    ), settings as (
      select nspname, relname, reltuples, n_live_tup, n_dead_tup, last_autovacuum,
        case when relopts like '%autovacuum_vacuum_threshold%'
          then substring(relopts, '.*autovacuum_vacuum_threshold=([0-9.]+).*')::int
          else current_setting('autovacuum_vacuum_threshold')::int end as av_t,
        case when relopts like '%autovacuum_vacuum_scale_factor%'
          then substring(relopts, '.*autovacuum_vacuum_scale_factor=([0-9.]+).*')::real
          else current_setting('autovacuum_vacuum_scale_factor')::real end as av_s
      from opts
    )
    select
      nspname as schema,
      nspname || '.' || relname as table,
      n_live_tup as live_rows,
      n_dead_tup as dead_rows,
      round(av_t + av_s * reltuples) as autovacuum_at,
      case when (av_t + av_s * reltuples) < n_dead_tup then 'yes' else 'no' end as overdue,
      to_char(last_autovacuum, 'YYYY-MM-DD HH24:MI') as last_autovacuum
    from settings
    where n_dead_tup > 0
    order by (case when (av_t + av_s * reltuples) < n_dead_tup then 0 else 1 end), n_dead_tup desc
    limit 20`,

  // Per-role connection usage vs each role's limit (rolconnlimit, else the
  // cluster max). Surfaces a single role exhausting its own connection budget.
  roleStats: /* sql */ `
    select
      rolname as role,
      (select count(*) from pg_stat_activity a where a.usename = r.rolname) as connections,
      case when rolconnlimit = -1
        then current_setting('max_connections')::int
        else rolconnlimit end as conn_limit
    from pg_roles r
    where rolcanlogin
    order by connections desc
    limit 20`,

  // RLS policies re-evaluating auth.* per row (should be wrapped: (select auth.uid())).
  // Supabase benchmarks: 94-99% latency improvement when wrapped.
  rlsPolicies: /* sql */ `
    select
      schemaname || '.' || tablename as table,
      policyname,
      cmd,
      (chk ~ 'auth\\.(uid|jwt|role)\\(\\)' and chk !~ '\\(\\s*select\\s+auth\\.') as unwrapped_auth
    from (
      select schemaname, tablename, policyname, cmd,
        coalesce(qual, '') || ' ' || coalesce(with_check, '') as chk
      from pg_policies
      where schemaname not in ('pg_catalog', 'information_schema')
    ) p
    order by 4 desc, 1`,

  storageUsage: /* sql */ `
    select
      bucket_id,
      count(*) as objects,
      pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as size
    from storage.objects
    group by bucket_id
    order by coalesce(sum((metadata->>'size')::bigint), 0) desc`,

  // Transaction-ID wraparound headroom. age(relfrozenxid) climbing toward 2.1B
  // means autovacuum is falling behind on freezing; at the ceiling the DB force-
  // stops writes. Scoped to non-system schemas (user-actionable); pct is against
  // a 2B practical ceiling (autovacuum_freeze_max_age escalates well before).
  txidWraparound: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as table,
      age(c.relfrozenxid) as xid_age,
      round(100 * age(c.relfrozenxid)::numeric / 2000000000, 1) as pct_wraparound
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'm')
      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and age(c.relfrozenxid) > 0
    order by age(c.relfrozenxid) desc
    limit 20`,

  // Replication slots + retained WAL. An INACTIVE slot pins WAL forever and can
  // fill the disk; a lagging active slot signals a slow downstream consumer.
  // Empty on projects with no logical replication / read replicas / CDC.
  replicationSlots: /* sql */ `
    select
      slot_name,
      slot_type,
      active,
      coalesce(pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
      ), '-') as retained_wal,
      pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as retained_wal_bytes
    from pg_replication_slots
    order by pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) desc nulls last`,

  connections: /* sql */ `
    select
      coalesce(state, '(none)') as state,
      count(*) as connections,
      max(extract(epoch from (now() - state_change))::int) as max_state_age_s
    from pg_stat_activity
    where pid <> pg_backend_pid()
    group by state
    order by connections desc`,
} as const;

export type QueryKey = keyof typeof QUERIES;
