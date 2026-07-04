import { z } from "zod";

/**
 * Multi-database support for the superuser (--db-url) tier. Targets come from
 * repeatable --db-url flags and/or a gitignored config file; each needs a
 * Supabase project ref (for the API + metrics planes, still served by the PAT).
 * The ref is auto-derived from the connstring when possible, so a bare list of
 * --db-url flags Just Works for Supabase pooler/direct strings.
 */

export type DbTarget = { ref: string; dbUrl: string; name?: string; region?: string };

const RawEntry = z.object({
  name: z.string().optional(),
  ref: z.string().optional(),
  region: z.string().optional(),
  dbUrl: z.string().min(1),
});
export type RawEntry = z.infer<typeof RawEntry>;

/** Config file: a bare array of entries, or { databases: [...] }. */
const DbConfig = z
  .union([z.array(RawEntry), z.object({ databases: z.array(RawEntry) })])
  .transform((d) => (Array.isArray(d) ? d : d.databases));

export function parseDbConfig(json: string): RawEntry[] {
  return DbConfig.parse(JSON.parse(json));
}

/** Supabase project refs are exactly 20 lowercase letters. */
export const REF = /^[a-z]{20}$/;

/**
 * Derive the Supabase project ref from a connection string:
 *  - pooler:  user is `role.ref`   (postgresql://supabase_admin.<ref>:pw@...pooler...)
 *  - direct:  host is `db.<ref>.supabase.co` (or `<ref>.supabase.co`)
 * Returns null for non-Supabase / underivable strings.
 */
export function refFromConnstring(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const user = decodeURIComponent(u.username);
  const dot = user.indexOf(".");
  if (dot >= 0) {
    const cand = user.slice(dot + 1);
    if (REF.test(cand)) return cand;
  }
  const host = u.hostname.match(/(?:^|\.)([a-z]{20})\.supabase\.(?:co|com)$/);
  if (host) return host[1]!;
  return null;
}

/**
 * Derive the AWS region from a Supabase pooler connstring - the pooler host is
 * `aws-<n>-<region>.pooler.supabase.com` (e.g. aws-1-ap-southeast-1). Used to
 * pick the right regional Grafana/ALB in a profile. Direct (`db.<ref>....`)
 * strings carry no region; returns null.
 */
export function regionFromConnstring(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const m = host.match(/^aws-\d+-([a-z]{2}-[a-z]+-\d+)\.pooler\.supabase\.com$/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** A redacted connstring for error/log messages - never leak the password. */
export function redactConnstring(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? "***@" : ""}${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable connstring>";
  }
}

/**
 * Resolve raw entries into targets with a concrete ref. `fallbackRef` (from a
 * single --ref) is only used when a ref can't be derived and there's ambiguity
 * to resolve - callers pass it only for a single target.
 */
export function resolveTargets(raw: RawEntry[], fallbackRef?: string): DbTarget[] {
  return raw.map((e) => {
    const ref = e.ref ?? refFromConnstring(e.dbUrl) ?? fallbackRef;
    if (!ref) {
      throw new Error(
        `cannot determine the Supabase project ref for ${redactConnstring(e.dbUrl)} - ` +
          `add "ref" to its config entry, or use --ref for a single --db-url`,
      );
    }
    return {
      ref,
      dbUrl: e.dbUrl,
      name: e.name,
      region: e.region ?? regionFromConnstring(e.dbUrl) ?? undefined,
    };
  });
}
