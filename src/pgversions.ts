/**
 * Vendored Postgres latest-minor + EOL table.
 *
 * Source: https://endoflife.date/api/postgresql.json (authoritative, machine-
 * readable). This is NOT LLM-guessed - it is refreshed from that endpoint and
 * kept honest by scripts/check-pgversions-drift.ts, which re-fetches and warns
 * when this table drifts (same advisory-drift pattern as check:lints /
 * check:inspect). Minor-version currency is otherwise only visible via the
 * Management API upgrade plane (PAT-only); this lets the no-PAT tier flag it
 * from server_version alone.
 */

export const PG_VERSIONS_AS_OF = "2026-07-15";

/** major -> { latest minor version string, EOL date (ISO) }. Modern (10+) only. */
export const PG_LATEST_MINOR: Record<string, { latest: string; eol: string }> = {
  "18": { latest: "18.4", eol: "2030-11-14" },
  "17": { latest: "17.10", eol: "2029-11-08" },
  "16": { latest: "16.14", eol: "2028-11-09" },
  "15": { latest: "15.18", eol: "2027-11-11" },
  "14": { latest: "14.23", eol: "2026-11-12" },
  "13": { latest: "13.23", eol: "2025-11-13" },
  "12": { latest: "12.22", eol: "2024-11-21" },
};

/**
 * Parse a server_version GUC ("15.1 (Ubuntu 15.1-1.pgdg20.04+1)", "17.6") into
 * {major, minor}. Modern Postgres only (major.minor); returns null otherwise.
 */
export function parsePgVersion(v: string): { major: string; minor: number } | null {
  const m = v.trim().match(/^(\d+)\.(\d+)/);
  if (!m?.[1] || m[2] == null) return null;
  return { major: m[1], minor: Number(m[2]) };
}

export type MinorLag = {
  major: string;
  current: string;
  latest: string;
  behind: number;
  eol: string;
};

/**
 * How many minor releases behind the latest the server is, or null when the
 * version is unparseable, the major is unknown to the table, or it is already
 * current. Only reasons about the minor (10+); majors <10 are not in the table.
 */
export function minorsBehind(serverVersion: string): MinorLag | null {
  const p = parsePgVersion(serverVersion);
  if (!p) return null;
  const entry = PG_LATEST_MINOR[p.major];
  if (!entry) return null;
  const latestMinor = Number(entry.latest.split(".")[1]);
  const behind = latestMinor - p.minor;
  if (!Number.isFinite(behind) || behind <= 0) return null;
  return {
    major: p.major,
    current: `${p.major}.${p.minor}`,
    latest: entry.latest,
    behind,
    eol: entry.eol,
  };
}
