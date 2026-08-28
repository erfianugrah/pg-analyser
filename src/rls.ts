/**
 * True when an RLS policy expression calls `auth.uid()` / `auth.jwt()` /
 * `auth.role()` WITHOUT wrapping it in a scalar sub-select. An unwrapped call
 * is re-evaluated once per row scanned; wrapping it as `(select auth.uid())`
 * lets Postgres evaluate it once per query (Supabase reports 94-99% latency
 * wins on large tables).
 *
 * Case-INSENSITIVE on purpose: Postgres stores a wrapped policy back as
 * `( SELECT auth.uid() AS uid)` (uppercase SELECT), so a case-sensitive "is it
 * wrapped?" check false-flags correctly-wrapped policies as unwrapped.
 */
export function isUnwrappedAuth(qual?: string | null, withCheck?: string | null): boolean {
  const expr = `${qual ?? ""} ${withCheck ?? ""}`;
  const callsAuth = /auth\.(uid|jwt|role)\(/i.test(expr);
  if (!callsAuth) return false;
  const wrapped = /\(\s*select\s+auth\./i.test(expr);
  return !wrapped;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a policy expression subqueries the policy's OWN table - the
 * infinite-recursion pattern (Postgres error 42P17 at runtime). This is NOT
 * detectable via pg_depend: verified on PG17, a policy's normal deps are all
 * column-level (refobjsubid = attnum), so a plain own-column compare and an
 * own-table subquery produce identical dep rows. The deparsed expression is
 * the discriminator: an own-table subquery prints `FROM org_user org_user_1`
 * (bare name + auto-alias) or schema-qualified, while a plain column compare
 * has no FROM at all. Matches FROM/JOIN/UPDATE/INTO followed by the own table
 * name (optionally quoted, optionally prefixed by its own schema).
 */
export function referencesOwnTable(
  table: string,
  qual?: string | null,
  withCheck?: string | null,
): boolean {
  // Strip string literals first: 'from my_table' inside a literal is data,
  // not a table reference, and would false-positive (verified on PG17:
  // note <> 'from t_lit' deparses with the literal intact).
  const raw = `${qual ?? ""} ${withCheck ?? ""}`;
  const expr = raw.replace(/'(?:[^']|'')*'/g, "''");
  if (!/\b(?:from|join|update|into)\b/i.test(expr)) return false;
  const parts = table.split(".");
  const tbl = parts[parts.length - 1];
  if (!tbl) return false;
  const schema = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
  const namePat = escapeRe(tbl);
  const schemaPat = schema ? `(?:"?${escapeRe(schema)}"?.)?` : "(?:[\\w$]+.)?";
  // The FROM target may open a parenthesised join group (verified PG17:
  // `FROM (joint j JOIN other o ...)`) - allow (s between keyword and name.
  return new RegExp(
    `\\b(?:from|join|update|into)\\s+\\(*\\s*${schemaPat}"?${namePat}"?\\b`,
    "i",
  ).test(expr);
}
