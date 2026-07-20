/**
 * Per-lint remediation catalog for Supabase Advisor (splinter) findings.
 *
 * Keyed by the bare lint `name` (no NNNN_ prefix) exactly as the advisors
 * endpoint returns it. This makes an advisor finding a one-stop shop: a
 * plain-English title + a per-lint "why it matters" + a concrete, hedged
 * What-to-do + optional copy-pasteable SQL + How-to-verify, instead of bouncing
 * the reader back to the Advisor page. The per-lint doc URL (from the lint
 * itself) and the dashboard deep-link stay as backstops (see findings.ts
 * groupAdvisors). When a lint has no catalog entry, findings.ts falls back to
 * the category-level advisor_performance / advisor_security meta.
 *
 * SQL templates use <angle-bracket> placeholders for the reader to fill from the
 * affected object (the lint's metadata/detail names it). ASCII only (commit-safe).
 *
 * whyItMatters is written to name the concrete mechanism/cost, not to assert
 * that the finding is important (no "this is crucial" filler) - each is specific
 * to its lint and validated against actual Postgres/Supabase behaviour.
 *
 * Kept in sync with the vendored src/splinter.sql by scripts/check-lints-drift.ts
 * (`bun run check:lints`): when upstream adds/renames a lint, the check warns so
 * this catalog gets a matching entry. Bump LINTS_REVIEWED when you re-confirm.
 */

export const LINTS_REVIEWED = "2026-07";

export interface LintFix {
  /** Plain-English, jargon-free finding title (<= ~10 words). */
  plainTitle: string;
  /**
   * Per-lint rationale: the concrete mechanism/cost of leaving it, specific to
   * this lint. Overrides the category-level advisor whyItMatters. Names the real
   * effect (a full scan, an OR-combined policy, an exposed column) - never
   * generic significance-inflation.
   */
  whyItMatters: string;
  /** Hedged, concrete action. Opens with "Consider ..." / "You might ...". */
  whatToDo: string;
  /** Optional copy-pasteable SQL/DDL template (<angle> placeholders). */
  sql?: string;
  /** One sentence: how to confirm the fix worked. */
  howToVerify: string;
  /**
   * Optional link to a Supabase changelog / known-issue entry that explains a
   * documented platform change behind this lint (e.g. a default that changed).
   * Rendered as an extra "Changelog" reference and surfaced to the narrate pass.
   * MUST be a real, verified URL - never a guess.
   */
  changelogUrl?: string;
}

export const LINT_FIXES: Record<string, LintFix> = {
  // --- Performance ---
  unindexed_foreign_keys: {
    plainTitle: "Foreign keys without a covering index",
    whyItMatters:
      "Postgres does not auto-index the child side of a foreign key. With no covering index, every parent DELETE or key UPDATE scans the whole child table to find referencing rows, and joins on the FK fall back to a sequential scan - a full-table read per operation once the child grows.",
    whatToDo:
      "Consider adding a covering index on the foreign-key column(s) so joins and cascading updates/deletes use an index instead of scanning the whole table.",
    sql: "CREATE INDEX CONCURRENTLY ON <schema>.<table> (<fkey_columns>);",
    howToVerify:
      "EXPLAIN a join on the FK - it should use the new index; the Advisor lint should clear.",
  },
  unused_index: {
    plainTitle: "Indexes that are never used",
    whyItMatters:
      "An index with idx_scan = 0 has served no read, but Postgres still updates it on every INSERT/UPDATE/DELETE and keeps it on disk and in cache. You pay the write amplification and storage with nothing back.",
    whatToDo:
      "Confirm the index does not back an occasional feature, then consider dropping it - an unused index is write overhead and storage for no read benefit.",
    sql: "DROP INDEX CONCURRENTLY IF EXISTS <schema>.<index>;",
    howToVerify:
      "Watch pg_stat_user_indexes.idx_scan over a full cycle - it should stay 0 before you drop it.",
  },
  duplicate_index: {
    plainTitle: "Duplicate indexes on the same table",
    whyItMatters:
      "Two indexes with the same definition do the same work twice: each is rebuilt on every write and each holds its own copy on disk and in the buffer cache. The planner only ever picks one, so the other is pure overhead.",
    whatToDo:
      "Keep one copy and consider dropping the rest - identical indexes each cost writes and storage for no extra read benefit.",
    sql: "DROP INDEX CONCURRENTLY IF EXISTS <schema>.<redundant_index>; -- keep one copy",
    howToVerify: "Check pg_indexes - only one definition should remain; the lint should clear.",
  },
  multiple_permissive_policies: {
    plainTitle: "Overlapping row-security policies on one table",
    whyItMatters:
      "Postgres OR-combines every permissive policy for a given role and action and evaluates all of them on each query. Two permissive policies where one would do doubles the per-row policy work on every read of the table.",
    whatToDo:
      "Consider consolidating the permissive policies for the same role and action into one - Postgres runs every permissive policy on each query, so fewer means less per-query work.",
    howToVerify:
      "Re-run the Performance Advisor - the lint should clear once each role+action has a single permissive policy.",
  },
  auth_rls_initplan: {
    plainTitle: "RLS policies re-evaluate auth.uid()/current_setting() per row",
    whyItMatters:
      "A bare auth.uid() or current_setting() in a policy is re-run for every row the query scans, so a 100k-row scan makes 100k function calls. Wrapping it in (select ...) turns it into an InitPlan the planner evaluates once - Supabase measured 94-99% lower latency on large tables from that one change.",
    whatToDo:
      "Consider wrapping the auth call in a subselect so Postgres evaluates it once per query instead of once per row. The same applies to auth.jwt(), auth.role() and current_setting().",
    sql: "-- per row (slow):\nusing ( auth.uid() = user_id )\n-- once per query (fast):\nusing ( (select auth.uid()) = user_id )",
    howToVerify:
      "EXPLAIN the policy-filtered query - the auth call should no longer run per row; the lint should clear.",
  },
  no_primary_key: {
    plainTitle: "Tables without a primary key",
    whyItMatters:
      "Logical replication needs a replica identity to name the row it is replicating (the primary key by default), ON CONFLICT upserts need a unique target to conflict on, and some client tooling can only address a row by its key. Without one, all three silently do not work.",
    whatToDo:
      "Consider adding a primary key - it is needed for logical replication, safe upserts, and several client features.",
    sql: "ALTER TABLE <schema>.<table> ADD PRIMARY KEY (<id_column>);",
    howToVerify: "Re-run the Advisor - the lint should clear once the table has a primary key.",
  },
  table_bloat: {
    plainTitle: "Table carrying significant dead space",
    whyItMatters:
      "Dead tuples from updates and deletes hold their pages until vacuum reclaims the space, so a scan reads more pages than the live rows need and the table occupies more disk than its data. The gap grows whenever churn outruns autovacuum.",
    whatToDo:
      "Consider reclaiming the bloat online with pg_repack (brief final lock). Avoid VACUUM FULL on hot tables - it holds an exclusive lock throughout.",
    sql: "-- from a client with the pg_repack extension available:\npg_repack -t <schema>.<table>",
    howToVerify: "Re-check the bloat estimate - the table's waste should drop after pg_repack.",
  },

  // --- Security ---
  auth_users_exposed: {
    plainTitle: "auth.users data is exposed to client roles",
    whyItMatters:
      "auth.users holds emails, hashed passwords, and tokens. A view that grants it to the anon or authenticated role makes those columns readable straight through the API - anyone holding the anon key can read account data.",
    whatToDo:
      "A view or materialized view exposes auth.users to the anon/authenticated roles. Consider revoking that access or removing the exposed columns.",
    sql: "REVOKE ALL ON <schema>.<view> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  policy_exists_rls_disabled: {
    plainTitle: "Policies defined but row security is off",
    whyItMatters:
      "Policies are inert until ENABLE ROW LEVEL SECURITY runs. The table looks protected because the policies exist, but with RLS off none of them apply and client roles get unrestricted access - the worst case, because it reads as safe.",
    whatToDo:
      "The table has policies but row-level security is disabled, so the policies are not enforced. Consider enabling RLS.",
    sql: "ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;",
    howToVerify: "Re-run the Security Advisor - the lint should clear once RLS is enabled.",
  },
  rls_enabled_no_policy: {
    plainTitle: "Row security is on but there are no policies",
    whyItMatters:
      "RLS with no policy is default-deny: client roles get zero rows. The table silently returns nothing through the API, which is almost always an accidental lockout rather than the intent.",
    whatToDo:
      "RLS is enabled with no policies, so the table returns no rows to client roles. Consider adding a policy (or disabling RLS if the lockout is unintended).",
    sql: '-- e.g. let owners read their own rows:\nCREATE POLICY "owner can read" ON <schema>.<table>\n  FOR SELECT USING ( (select auth.uid()) = <owner_column> );',
    howToVerify:
      "Query the table as an authenticated role - the intended rows should return; the lint should clear.",
  },
  rls_disabled_in_public: {
    plainTitle: "Public table with row security off",
    whyItMatters:
      "The table is reachable through PostgREST and RLS is off, so any anon-key holder can read and write every row. This is the most direct data-exposure path Supabase flags.",
    whatToDo:
      "A table reachable via the API has RLS disabled, so any client role can read and write it. Consider enabling RLS and adding policies.",
    sql: "ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;",
    howToVerify:
      "Re-run the Security Advisor - the lint should clear once RLS is enabled with policies.",
  },
  security_definer_view: {
    plainTitle: "View runs with its owner's privileges",
    whyItMatters:
      "A SECURITY DEFINER view runs queries as its owner, not the caller, so it returns rows the caller's own RLS would hide. A client can read past their row-level restrictions by going through the view.",
    whatToDo:
      "A SECURITY DEFINER view bypasses the querying user's row-level security. Consider recreating it as SECURITY INVOKER unless the elevation is intentional.",
    sql: "ALTER VIEW <schema>.<view> SET (security_invoker = true);",
    howToVerify: "Confirm the view returns the expected rows per role - the lint should clear.",
  },
  function_search_path_mutable: {
    plainTitle: "Function without a fixed search_path",
    whyItMatters:
      "With no pinned search_path, the function resolves unqualified names against the caller's search_path. A table or function planted in another schema can shadow the intended one, so attacker-controlled code runs with the function's rights.",
    whatToDo:
      "Consider pinning the function's search_path so it cannot be hijacked by objects created in another schema.",
    sql: "ALTER FUNCTION <schema>.<function>(<args>) SET search_path = '';",
    howToVerify: "Re-run the Security Advisor - the lint should clear once search_path is set.",
  },
  extension_in_public: {
    plainTitle: "Extension installed in the public schema",
    whyItMatters:
      "Objects in public are exposed on the PostgREST API and share the namespace your app tables use. An extension there widens the API surface and can collide with app object names - a dedicated schema keeps it off both.",
    whatToDo:
      "Consider moving the extension to a dedicated schema so its objects are not exposed on the public API surface.",
    sql: "ALTER EXTENSION <extension> SET SCHEMA extensions;",
    howToVerify: "Re-run the Security Advisor - the lint should clear once it is out of public.",
  },
  rls_references_user_metadata: {
    plainTitle: "Policy trusts user-editable metadata",
    whyItMatters:
      "user_metadata is writable by the user through the Auth API. A policy that reads it lets a user grant themselves access by editing their own metadata - app_metadata (server-controlled) does not have that hole.",
    whatToDo:
      "A policy reads user_metadata, which the user can edit. Consider basing the check on app_metadata or a server-controlled table instead.",
    howToVerify:
      "Re-run the Security Advisor - the lint should clear once the policy no longer reads user_metadata.",
  },
  materialized_view_in_api: {
    plainTitle: "Materialized view exposed on the API",
    whyItMatters:
      "RLS is not applied to materialized views. Once one is reachable through the API, every row in it is readable by any client role that can query it - policies on the underlying tables do not carry over.",
    whatToDo:
      "A materialized view is reachable via the API and RLS does not apply to it. Consider revoking client access or moving it out of the exposed schema.",
    sql: "REVOKE ALL ON <schema>.<matview> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  foreign_table_in_api: {
    plainTitle: "Foreign table exposed on the API",
    whyItMatters:
      "RLS is not enforced on foreign tables. A client role that can reach one through the API reads whatever the foreign server returns, with no row filtering.",
    whatToDo:
      "A foreign table is reachable via the API and RLS does not apply to it. Consider moving it out of the exposed schema or revoking client access.",
    sql: "REVOKE ALL ON <schema>.<foreign_table> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  insecure_queue_exposed_in_api: {
    plainTitle: "Message queue exposed on the API",
    whyItMatters:
      "The pgmq queue table is reachable through the API, so a client can read queued messages or tamper with them - dequeue, re-order, or inject work that the backend will process.",
    whatToDo:
      "A pgmq queue is reachable via the API. Consider disabling API exposure for the queue or restricting its role grants.",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  sensitive_columns_exposed: {
    plainTitle: "Sensitive columns readable via the API",
    whyItMatters:
      "Columns that look like secrets (tokens, keys, password hashes) are selectable by the anon or authenticated role, so they come back in ordinary API reads of the row - not just to code that means to fetch them.",
    whatToDo:
      "Columns that look sensitive are readable by client roles. Consider revoking column-level access or serving them through a restricted view.",
    sql: "REVOKE SELECT (<sensitive_column>) ON <schema>.<table> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  rls_policy_always_true: {
    plainTitle: "Policy that always passes (no restriction)",
    whyItMatters:
      "The policy's USING/WITH CHECK expression is a constant true, so it admits every row. It enforces nothing - the same as running the table with no policy at all, while looking protected.",
    whatToDo:
      "A policy's USING/WITH CHECK expression is always true, so it grants unrestricted access. Consider tightening it to an ownership or role check.",
    howToVerify:
      "Re-run the Security Advisor - the lint should clear once the policy restricts rows.",
  },
  public_bucket_allows_listing: {
    plainTitle: "Public storage bucket allows listing",
    whyItMatters:
      "A public bucket lets anonymous callers list every object key. Even if a file's contents need a signed URL, its name and existence are discoverable, which leaks structure and filenames you may have assumed were private.",
    whatToDo:
      "A public bucket lets anonymous users list its objects. Consider making the bucket private or adding storage access policies.",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  pg_graphql_anon_table_exposed: {
    plainTitle: "Table exposed to anonymous GraphQL",
    whyItMatters:
      "The anon role can query the table through the GraphQL endpoint, so anyone holding the anon key reads it without authenticating - the GraphQL surface is a second door past the REST one.",
    whatToDo:
      "A table is reachable by the anon role through GraphQL. Consider revoking anon access or adding row-level security.",
    sql: "REVOKE ALL ON <schema>.<table> FROM anon;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
    changelogUrl:
      "https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically",
  },
  pg_graphql_authenticated_table_exposed: {
    plainTitle: "Table broadly exposed to authenticated GraphQL",
    whyItMatters:
      "Every logged-in user can query the table through GraphQL and no RLS filters it, so any single authenticated account reads all rows - one compromised or curious user sees everyone's data.",
    whatToDo:
      "A table is reachable by every authenticated user through GraphQL with no row-level security. Consider adding RLS or restricting the grant.",
    sql: "ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
    changelogUrl:
      "https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically",
  },
  anon_security_definer_function_executable: {
    plainTitle: "Anonymous users can run an owner-privileged function",
    whyItMatters:
      "The anon role can call a SECURITY DEFINER function, which runs with the owner's rights. An unauthenticated caller executes privileged code - whatever the owner can do, anon can trigger.",
    whatToDo:
      "The anon role can execute a SECURITY DEFINER function (which runs with the owner's rights). Consider revoking execute from anon unless it is meant to be public.",
    sql: "REVOKE EXECUTE ON FUNCTION <schema>.<function>(<args>) FROM anon;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  authenticated_security_definer_function_executable: {
    plainTitle: "All users can run an owner-privileged function",
    whyItMatters:
      "Every authenticated user can call a SECURITY DEFINER function that runs with the owner's rights, so any account executes privileged code. Scope execute to the roles that actually need it.",
    whatToDo:
      "Every authenticated user can execute a SECURITY DEFINER function. Consider restricting execute to only the roles that need it.",
    sql: "REVOKE EXECUTE ON FUNCTION <schema>.<function>(<args>) FROM authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  fkey_to_auth_unique: {
    plainTitle: "Foreign key to a non-unique auth column",
    whyItMatters:
      "The foreign key references an auth column with no unique guarantee, so one referencing row can match more than one auth record. Joins and cascades then act on an ambiguous target - point it at auth.users(id).",
    whatToDo:
      "A foreign key references an auth column that is not guaranteed unique. Consider pointing it at auth.users(id) instead.",
    howToVerify: "Re-run the Advisor - the lint should clear once the FK targets a unique column.",
  },

  // --- Other / durability ---
  extension_versions_outdated: {
    plainTitle: "Extension running an outdated version",
    whyItMatters:
      "The installed version is behind the one shipped for your Postgres, so you are running without its bug and security fixes until ALTER EXTENSION ... UPDATE brings it current.",
    whatToDo: "Consider upgrading the extension to the latest available version to pick up fixes.",
    sql: "ALTER EXTENSION <extension> UPDATE;",
    howToVerify:
      "Check extversion in pg_extension - it should match the latest; the lint should clear.",
  },
  unsupported_reg_types: {
    plainTitle: "Columns using unsupported reg* types",
    whyItMatters:
      "reg* columns (e.g. regclass, regproc) hold references tied to this database's catalog OIDs. A dump/restore into another database can resolve them to the wrong object or fail, so the data does not travel cleanly.",
    whatToDo:
      "Some columns use reg* types (e.g. regclass) that do not survive a dump/restore cleanly. Consider storing the value as text or oid instead.",
    howToVerify: "Re-run the Advisor - the lint should clear once the reg* columns are migrated.",
  },
};

/** Look up a fix by lint name, tolerating a leading NNNN_ prefix. */
export function lintFix(name: string): LintFix | undefined {
  return LINT_FIXES[name] ?? LINT_FIXES[name.replace(/^[0-9]{4}_/, "")];
}
