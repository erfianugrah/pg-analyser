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

  cacheHit: /* sql */ `
    select round(
      sum(heap_blks_hit) * 100.0
      / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2
    ) as cache_hit_pct
    from pg_statio_user_tables`,

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

  // MVCC bloat / autovacuum-behind. Thresholded by ABSOLUTE dead tuples so
  // tiny tables (e.g. 22 dead rows) don't headline with alarming ratios.
  deadTuples: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      n_live_tup as live_rows,
      n_dead_tup as dead_rows,
      case when n_live_tup > 0
        then round((n_dead_tup::numeric / n_live_tup) * 100, 1)
        else null end as dead_pct,
      last_autovacuum
    from pg_stat_user_tables
    where n_dead_tup >= 1000
       or (n_dead_tup >= 100 and n_live_tup > 0 and n_dead_tup::numeric / n_live_tup >= 0.2)
    order by n_dead_tup desc
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
