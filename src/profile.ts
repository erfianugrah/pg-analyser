import { z } from "zod";
import type { RawEntry } from "./dbtargets.ts";

/**
 * A profile is the whole work config in ONE gitignored JSON: force-no-PAT, the
 * region-mapped Grafana credentials (each region is a separate ALB, so a
 * per-region cookie), and the customer databases. Drive it with
 * `sbperf full --profile <file>` - no .env, no wrapper. Nothing here is baked
 * into the repo: hosts, datasource UIDs, cookies and connstrings all live in
 * the (gitignored) profile file.
 */

const RegionCreds = z.object({
  /** The ALB session cookie for THIS region's Grafana (whole Cookie header). */
  cookie: z.string().min(1),
  /** Per-region datasource UID override (else grafana.datasourceUid). */
  uid: z.string().optional(),
  /** Per-region full host override (else grafana.hostTemplate with {region}). */
  host: z.string().optional(),
});

const GrafanaMap = z.object({
  /** Host with a {region} placeholder, e.g. https://grafana-{region}.example/. */
  hostTemplate: z.string().optional(),
  /** Datasource UID shared across regions (per-region override in regions[]). */
  datasourceUid: z.string().optional(),
  /** Project-label selector template; {ref} substituted per project. */
  matcher: z.string().default('supabase_project_ref="{ref}"'),
  /** region -> credentials. Keyed by the AWS region (e.g. ap-southeast-1). */
  regions: z.record(z.string(), RegionCreds).default({}),
});

export const Profile = z.object({
  /** Force no-PAT mode (default true - a profile is the customer-audit path). */
  noPat: z.boolean().default(true),
  /** Region-mapped Grafana trend credentials (optional - omit for SQL-only). */
  grafana: GrafanaMap.optional(),
  /** Customer databases: superuser connstrings (ref/region derived if absent). */
  databases: z
    .array(
      z.object({
        name: z.string().optional(),
        ref: z.string().optional(),
        region: z.string().optional(),
        dbUrl: z.string().min(1),
      }),
    )
    .min(1),
});
export type Profile = z.infer<typeof Profile>;

export function parseProfile(json: string): Profile {
  return Profile.parse(JSON.parse(json));
}

/** The profile's databases as db-target raw entries (ref/region derived later). */
export function profileEntries(p: Profile): RawEntry[] {
  return p.databases.map((d) => ({
    name: d.name,
    ref: d.ref,
    region: d.region,
    dbUrl: d.dbUrl,
  }));
}

/**
 * Resolve the Grafana trend config for one project in a given region:
 * regional host (template or override) + datasource UID + that region's cookie.
 * Returns null (trends skipped for this project) when there's no grafana block,
 * no region, or the region isn't in the map / lacks a resolvable host+uid. The
 * matcher's {ref} is substituted downstream by fetchTrends.
 */
export function resolveGrafana(
  p: Profile,
  region: string | null | undefined,
): { url: string; cookie: string; matcher: string } | null {
  const g = p.grafana;
  if (!g || !region) return null;
  const creds = g.regions[region];
  if (!creds) return null;
  const host = creds.host ?? g.hostTemplate?.replaceAll("{region}", region);
  const uid = creds.uid ?? g.datasourceUid;
  if (!host || !uid) return null;
  const base = host.replace(/\/+$/, "");
  return {
    url: `${base}/api/datasources/proxy/uid/${uid}`,
    cookie: creds.cookie,
    matcher: g.matcher,
  };
}
