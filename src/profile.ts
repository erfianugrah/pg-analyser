import { z } from "zod";
import type { RawEntry } from "./dbtargets.ts";

/**
 * A profile is the whole no-PAT config in ONE gitignored JSON: force-no-PAT, the
 * region-mapped Grafana credentials (each region is a separate ALB, so a
 * per-region cookie - see GrafanaMap.regions below for what to do when two
 * DBs share a region but need different Grafana credentials), and the target
 * databases. Drive it with
 * `pg-analyser full --profile <file>` - no .env, no wrapper. Nothing here is baked
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
  /**
   * region -> credentials. Keyed by the AWS region (e.g. ap-southeast-1) -
   * ONE Grafana target per region PER PROFILE. Two databases that share an
   * AWS region but need different Grafana hosts/cookies (e.g. two orgs both
   * in ap-southeast-1) can't both go under one region key here - split them
   * into separate profile files instead and chain with repeated --profile
   * flags (see index.ts's --profile help; runnable example:
   * pg-analyser.org-a.profile.example.json + pg-analyser.org-b.profile.example.json,
   * both keyed on the same region with different cookies); each target
   * resolves Grafana against its OWNING profile, so the same region string in
   * two files never collides.
   */
  regions: z.record(z.string(), RegionCreds).default({}),
});

export const Profile = z.object({
  /** Force no-PAT mode (default true - a profile is the no-PAT path). */
  noPat: z.boolean().default(true),
  /** Trend query window in days (Grafana/Prometheus range; default 30). The
   * dashboards go to 90d - it's a TSDB, not the ~7-day analytics cap. */
  trendDays: z.number().int().positive().max(365).optional(),
  /** Region-mapped Grafana trend credentials (optional - omit for SQL-only). */
  grafana: GrafanaMap.optional(),
  /** Target databases: superuser connstrings (ref/region derived if absent). */
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
 * no region, or the region isn't in the map / lacks a resolvable host+uid (main()
 * rejects those three up front via grafanaProfileProblems). The
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

/** AWS region shape (ap-southeast-1, us-gov-west-1); a key outside it is a typo. */
const AWS_REGION = /^[a-z]{2}(-gov)?-(north|south|east|west|central|(north|south)(east|west))-\d+$/;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Config problems that would leave a profile's databases without trends. A
 * profile with a grafana block asks for trends, so a region key that is not an
 * AWS region, a region entry with no host/uid, or a database whose region has
 * no entry is a mistake in the file - reported up front, before any database
 * is touched, instead of a collection note found after the sweep. Empty when
 * the profile has no grafana block (SQL-only is a valid choice) or every
 * database resolves. A database that should run without trends belongs in a
 * separate profile with no grafana block, chained with another --profile.
 */
export function grafanaProfileProblems(
  p: Profile,
  targets: ReadonlyArray<{ name?: string; ref: string; region?: string | null }>,
): string[] {
  const g = p.grafana;
  if (!g) return [];
  const problems: string[] = [];
  const keys = Object.keys(g.regions);
  const targetRegions = [...new Set(targets.flatMap((t) => (t.region ? [t.region] : [])))];
  for (const key of keys) {
    if (!AWS_REGION.test(key)) {
      const near = targetRegions.find((r) => editDistance(r, key) <= 2);
      problems.push(
        `grafana.regions key "${key}" is not an AWS region name${near ? ` (did you mean "${near}"?)` : ""}`,
      );
    }
    const creds = g.regions[key]!;
    if (!creds.host && !g.hostTemplate)
      problems.push(
        `grafana.regions["${key}"] has no host: set grafana.hostTemplate or a per-region "host"`,
      );
    if (!creds.uid && !g.datasourceUid)
      problems.push(
        `grafana.regions["${key}"] has no datasource uid: set grafana.datasourceUid or a per-region "uid"`,
      );
  }
  for (const t of targets) {
    const who = `database "${t.name ?? t.ref}" (${t.ref})`;
    if (!t.region) {
      problems.push(
        `${who}: region can't be derived from its connstring - set "region" on its databases[] entry`,
      );
    } else if (!g.regions[t.region]) {
      problems.push(
        `${who} is in ${t.region}, but grafana.regions maps: ${keys.join(", ") || "(none)"} - add "${t.region}", or move this database to a profile without a grafana block`,
      );
    }
  }
  return problems;
}
