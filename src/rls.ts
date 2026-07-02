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
