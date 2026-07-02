/**
 * The perf diagnostic query set. Sourced from the Supabase Postgres
 * best-practices `monitor-` rules: pg_stat_statements for slow queries,
 * seq_scan >> idx_scan for missing indexes, n_dead_tup for MVCC bloat,
 * cache-hit ratio, index usage, and connection state.
 *
 * All are read-only and run via the Management API read-only SQL runner
 * (as supabase_read_only_user). pg_stat_statements lives in the `extensions`
 * schema on Supabase.
 */
export const QUERIES = {
  dbSize: /* sql */ `
    select pg_size_pretty(pg_database_size(current_database())) as db_size`,

  cacheHit: /* sql */ `
    select round(
      sum(heap_blks_hit) * 100.0
      / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2
    ) as cache_hit_pct
    from pg_statio_user_tables`,

  topStatements: /* sql */ `
    select
      round(total_exec_time::numeric, 1) as total_ms,
      calls,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1) as pct,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    order by total_exec_time desc
    limit 20`,

  biggestTables: /* sql */ `
    select
      schemaname || '.' || relname as table,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size,
      pg_size_pretty(pg_relation_size(relid)) as table_size,
      pg_size_pretty(pg_indexes_size(relid)) as index_size,
      n_live_tup as live_rows
    from pg_stat_user_tables
    order by pg_total_relation_size(relid) desc
    limit 20`,

  unusedIndexes: /* sql */ `
    select
      schemaname || '.' || relname as table,
      indexrelname as index,
      pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
      idx_scan as scans
    from pg_stat_user_indexes
    where idx_scan = 0
      and indexrelid not in (select conindid from pg_constraint where contype in ('p', 'u'))
    order by pg_relation_size(indexrelid) desc
    limit 25`,

  seqScanHeavy: /* sql */ `
    select
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

  deadTuples: /* sql */ `
    select
      schemaname || '.' || relname as table,
      n_live_tup as live_rows,
      n_dead_tup as dead_rows,
      case when n_live_tup > 0
        then round((n_dead_tup::numeric / n_live_tup) * 100, 1)
        else 0 end as dead_pct,
      last_autovacuum
    from pg_stat_user_tables
    where n_dead_tup > 0
    order by n_dead_tup desc
    limit 20`,

  connections: /* sql */ `
    select
      state,
      count(*) as connections,
      max(extract(epoch from (now() - state_change))::int) as max_state_age_s
    from pg_stat_activity
    where pid <> pg_backend_pid()
    group by state
    order by connections desc`,
} as const;

export type QueryKey = keyof typeof QUERIES;
