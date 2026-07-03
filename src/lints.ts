/**
 * Per-lint remediation catalog for Supabase Advisor (splinter) findings.
 *
 * Keyed by the bare lint `name` (no NNNN_ prefix) exactly as the advisors
 * endpoint returns it. This makes an advisor finding a one-stop shop: a
 * plain-English title + a concrete, hedged What-to-do + optional copy-pasteable
 * SQL + How-to-verify, instead of bouncing the reader back to the Advisor page.
 * The per-lint doc URL (from the lint itself) and the dashboard deep-link stay
 * as backstops (see findings.ts groupAdvisors).
 *
 * SQL templates use <angle-bracket> placeholders for the reader to fill from the
 * affected object (the lint's metadata/detail names it). ASCII only (commit-safe).
 *
 * Kept in sync with the vendored src/splinter.sql by scripts/check-lints-drift.ts
 * (`bun run check:lints`): when upstream adds/renames a lint, the check warns so
 * this catalog gets a matching entry. Bump LINTS_REVIEWED when you re-confirm.
 */

export const LINTS_REVIEWED = "2026-07";

export interface LintFix {
  /** Plain-English, jargon-free finding title (<= ~10 words). */
  plainTitle: string;
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
    whatToDo:
      "Consider adding a covering index on the foreign-key column(s) so joins and cascading updates/deletes use an index instead of scanning the whole table.",
    sql: "CREATE INDEX CONCURRENTLY ON <schema>.<table> (<fkey_columns>);",
    howToVerify:
      "EXPLAIN a join on the FK - it should use the new index; the Advisor lint should clear.",
  },
  unused_index: {
    plainTitle: "Indexes that are never used",
    whatToDo:
      "Confirm the index does not back an occasional feature, then consider dropping it - an unused index is write overhead and storage for no read benefit.",
    sql: "DROP INDEX CONCURRENTLY IF EXISTS <schema>.<index>;",
    howToVerify:
      "Watch pg_stat_user_indexes.idx_scan over a full cycle - it should stay 0 before you drop it.",
  },
  duplicate_index: {
    plainTitle: "Duplicate indexes on the same table",
    whatToDo:
      "Keep one copy and consider dropping the rest - identical indexes each cost writes and storage for no extra read benefit.",
    sql: "DROP INDEX CONCURRENTLY IF EXISTS <schema>.<redundant_index>; -- keep one copy",
    howToVerify: "Check pg_indexes - only one definition should remain; the lint should clear.",
  },
  multiple_permissive_policies: {
    plainTitle: "Overlapping row-security policies on one table",
    whatToDo:
      "Consider consolidating the permissive policies for the same role and action into one - Postgres runs every permissive policy on each query, so fewer means less per-query work.",
    howToVerify:
      "Re-run the Performance Advisor - the lint should clear once each role+action has a single permissive policy.",
  },
  auth_rls_initplan: {
    plainTitle: "Security rules re-check the same value on every row",
    whatToDo:
      "Consider wrapping the auth call in a subselect so Postgres evaluates it once per query instead of once per row. The same applies to auth.jwt(), auth.role() and current_setting().",
    sql: "-- per row (slow):\nusing ( auth.uid() = user_id )\n-- once per query (fast):\nusing ( (select auth.uid()) = user_id )",
    howToVerify:
      "EXPLAIN the policy-filtered query - the auth call should no longer run per row; the lint should clear.",
  },
  no_primary_key: {
    plainTitle: "Tables without a primary key",
    whatToDo:
      "Consider adding a primary key - it is needed for logical replication, safe upserts, and several client features.",
    sql: "ALTER TABLE <schema>.<table> ADD PRIMARY KEY (<id_column>);",
    howToVerify: "Re-run the Advisor - the lint should clear once the table has a primary key.",
  },
  table_bloat: {
    plainTitle: "Table carrying significant dead space",
    whatToDo:
      "Consider reclaiming the bloat online with pg_repack (brief final lock). Avoid VACUUM FULL on hot tables - it holds an exclusive lock throughout.",
    sql: "-- from a client with the pg_repack extension available:\npg_repack -t <schema>.<table>",
    howToVerify: "Re-check the bloat estimate - the table's waste should drop after pg_repack.",
  },

  // --- Security ---
  auth_users_exposed: {
    plainTitle: "auth.users data is exposed to client roles",
    whatToDo:
      "A view or materialized view exposes auth.users to the anon/authenticated roles. Consider revoking that access or removing the exposed columns.",
    sql: "REVOKE ALL ON <schema>.<view> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  policy_exists_rls_disabled: {
    plainTitle: "Policies defined but row security is off",
    whatToDo:
      "The table has policies but row-level security is disabled, so the policies are not enforced. Consider enabling RLS.",
    sql: "ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;",
    howToVerify: "Re-run the Security Advisor - the lint should clear once RLS is enabled.",
  },
  rls_enabled_no_policy: {
    plainTitle: "Row security is on but there are no policies",
    whatToDo:
      "RLS is enabled with no policies, so the table returns no rows to client roles. Consider adding a policy (or disabling RLS if the lockout is unintended).",
    sql: '-- e.g. let owners read their own rows:\nCREATE POLICY "owner can read" ON <schema>.<table>\n  FOR SELECT USING ( (select auth.uid()) = <owner_column> );',
    howToVerify:
      "Query the table as an authenticated role - the intended rows should return; the lint should clear.",
  },
  rls_disabled_in_public: {
    plainTitle: "Public table with row security off",
    whatToDo:
      "A table reachable via the API has RLS disabled, so any client role can read and write it. Consider enabling RLS and adding policies.",
    sql: "ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;",
    howToVerify:
      "Re-run the Security Advisor - the lint should clear once RLS is enabled with policies.",
  },
  security_definer_view: {
    plainTitle: "View runs with its owner's privileges",
    whatToDo:
      "A SECURITY DEFINER view bypasses the querying user's row-level security. Consider recreating it as SECURITY INVOKER unless the elevation is intentional.",
    sql: "ALTER VIEW <schema>.<view> SET (security_invoker = true);",
    howToVerify: "Confirm the view returns the expected rows per role - the lint should clear.",
  },
  function_search_path_mutable: {
    plainTitle: "Function without a fixed search_path",
    whatToDo:
      "Consider pinning the function's search_path so it cannot be hijacked by objects created in another schema.",
    sql: "ALTER FUNCTION <schema>.<function>(<args>) SET search_path = '';",
    howToVerify: "Re-run the Security Advisor - the lint should clear once search_path is set.",
  },
  extension_in_public: {
    plainTitle: "Extension installed in the public schema",
    whatToDo:
      "Consider moving the extension to a dedicated schema so its objects are not exposed on the public API surface.",
    sql: "ALTER EXTENSION <extension> SET SCHEMA extensions;",
    howToVerify: "Re-run the Security Advisor - the lint should clear once it is out of public.",
  },
  rls_references_user_metadata: {
    plainTitle: "Policy trusts user-editable metadata",
    whatToDo:
      "A policy reads user_metadata, which the user can edit. Consider basing the check on app_metadata or a server-controlled table instead.",
    howToVerify:
      "Re-run the Security Advisor - the lint should clear once the policy no longer reads user_metadata.",
  },
  materialized_view_in_api: {
    plainTitle: "Materialized view exposed on the API",
    whatToDo:
      "A materialized view is reachable via the API and RLS does not apply to it. Consider revoking client access or moving it out of the exposed schema.",
    sql: "REVOKE ALL ON <schema>.<matview> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  foreign_table_in_api: {
    plainTitle: "Foreign table exposed on the API",
    whatToDo:
      "A foreign table is reachable via the API and RLS does not apply to it. Consider moving it out of the exposed schema or revoking client access.",
    sql: "REVOKE ALL ON <schema>.<foreign_table> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  insecure_queue_exposed_in_api: {
    plainTitle: "Message queue exposed on the API",
    whatToDo:
      "A pgmq queue is reachable via the API. Consider disabling API exposure for the queue or restricting its role grants.",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  sensitive_columns_exposed: {
    plainTitle: "Sensitive columns readable via the API",
    whatToDo:
      "Columns that look sensitive are readable by client roles. Consider revoking column-level access or serving them through a restricted view.",
    sql: "REVOKE SELECT (<sensitive_column>) ON <schema>.<table> FROM anon, authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  rls_policy_always_true: {
    plainTitle: "Policy that always passes (no restriction)",
    whatToDo:
      "A policy's USING/WITH CHECK expression is always true, so it grants unrestricted access. Consider tightening it to an ownership or role check.",
    howToVerify:
      "Re-run the Security Advisor - the lint should clear once the policy restricts rows.",
  },
  public_bucket_allows_listing: {
    plainTitle: "Public storage bucket allows listing",
    whatToDo:
      "A public bucket lets anonymous users list its objects. Consider making the bucket private or adding storage access policies.",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  pg_graphql_anon_table_exposed: {
    plainTitle: "Table exposed to anonymous GraphQL",
    whatToDo:
      "A table is reachable by the anon role through GraphQL. Consider revoking anon access or adding row-level security.",
    sql: "REVOKE ALL ON <schema>.<table> FROM anon;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
    changelogUrl:
      "https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically",
  },
  pg_graphql_authenticated_table_exposed: {
    plainTitle: "Table broadly exposed to authenticated GraphQL",
    whatToDo:
      "A table is reachable by every authenticated user through GraphQL with no row-level security. Consider adding RLS or restricting the grant.",
    sql: "ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
    changelogUrl:
      "https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically",
  },
  anon_security_definer_function_executable: {
    plainTitle: "Anonymous users can run an owner-privileged function",
    whatToDo:
      "The anon role can execute a SECURITY DEFINER function (which runs with the owner's rights). Consider revoking execute from anon unless it is meant to be public.",
    sql: "REVOKE EXECUTE ON FUNCTION <schema>.<function>(<args>) FROM anon;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  authenticated_security_definer_function_executable: {
    plainTitle: "All users can run an owner-privileged function",
    whatToDo:
      "Every authenticated user can execute a SECURITY DEFINER function. Consider restricting execute to only the roles that need it.",
    sql: "REVOKE EXECUTE ON FUNCTION <schema>.<function>(<args>) FROM authenticated;",
    howToVerify: "Re-run the Security Advisor - the lint should clear.",
  },
  fkey_to_auth_unique: {
    plainTitle: "Foreign key to a non-unique auth column",
    whatToDo:
      "A foreign key references an auth column that is not guaranteed unique. Consider pointing it at auth.users(id) instead.",
    howToVerify: "Re-run the Advisor - the lint should clear once the FK targets a unique column.",
  },

  // --- Other / durability ---
  extension_versions_outdated: {
    plainTitle: "Extension running an outdated version",
    whatToDo: "Consider upgrading the extension to the latest available version to pick up fixes.",
    sql: "ALTER EXTENSION <extension> UPDATE;",
    howToVerify:
      "Check extversion in pg_extension - it should match the latest; the lint should clear.",
  },
  unsupported_reg_types: {
    plainTitle: "Columns using unsupported reg* types",
    whatToDo:
      "Some columns use reg* types (e.g. regclass) that do not survive a dump/restore cleanly. Consider storing the value as text or oid instead.",
    howToVerify: "Re-run the Advisor - the lint should clear once the reg* columns are migrated.",
  },
};

/** Look up a fix by lint name, tolerating a leading NNNN_ prefix. */
export function lintFix(name: string): LintFix | undefined {
  return LINT_FIXES[name] ?? LINT_FIXES[name.replace(/^[0-9]{4}_/, "")];
}
