import { deriveFindings, type Finding, type Severity } from "../findings.ts";
import type { Advisor, Analysis, SqlRow } from "../schemas.ts";

const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>]/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m] as string,
  );

/** Advisor text is markdown with backslash-escaped backticks; unescape for display. */
const cleanText = (s: unknown): string => esc(String(s ?? "").replace(/\\`/g, "`"));

const bytes = (n: number | null): string => {
  if (n == null) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

function sqlTable(
  rows: SqlRow[],
  opts: { mono?: string[]; limit?: number; hide?: string[] } = {},
): string {
  if (!rows.length) return `<p class=empty>none found</p>`;
  const cols = Object.keys(rows[0]!).filter((c) => !opts.hide?.includes(c));
  const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
  const mono = new Set(opts.mono ?? []);
  const th = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = shown
    .map(
      (r) =>
        "<tr>" +
        cols.map((c) => `<td${mono.has(c) ? " class=mono" : ""}>${esc(r[c])}</td>`).join("") +
        "</tr>",
    )
    .join("");
  const more =
    opts.limit && rows.length > opts.limit
      ? `<p class=empty>+${rows.length - opts.limit} more rows</p>`
      : "";
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

const LEVEL_ORDER: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2 };
function advisorTable(list: Advisor[]): string {
  if (!list.length) return `<p class=empty>no findings</p>`;
  const sorted = [...list].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9),
  );
  const rows = sorted
    .map(
      (a) => `<tr>
      <td><span class="lvl ${esc(a.level)}">${esc(a.level)}</span></td>
      <td>${esc(a.title)}</td>
      <td>${cleanText(a.detail ?? a.description)}</td>
      <td>${a.remediation ? `<a href="${esc(a.remediation)}">docs</a>` : ""}</td>
    </tr>`,
    )
    .join("");
  return `<table class=adv><thead><tr><th>level</th><th>finding</th><th>detail</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pgSettingsTable(rows: SqlRow[]): string {
  if (!rows.length) return `<p class=empty>not collected</p>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td class=mono>${esc(r.name)}</td><td class=mono>${esc(r.setting)}${r.unit ? ` ${esc(r.unit)}` : ""}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>parameter</th><th>value</th></tr></thead><tbody>${body}</tbody></table>`;
}

function rlsTable(rows: SqlRow[]): string {
  if (!rows.length) return `<p class=empty>no RLS policies</p>`;
  const sorted = [...rows].sort(
    (a, b) => Number(b.unwrapped_auth === true) - Number(a.unwrapped_auth === true),
  );
  const body = sorted
    .map(
      (r) => `<tr class="${r.unwrapped_auth === true ? "flag" : ""}">
      <td class=mono>${esc(r.table)}</td><td>${esc(r.policyname)}</td><td>${esc(r.cmd)}</td>
      <td>${r.unwrapped_auth === true ? '<span class="badge warn">per-row auth</span>' : '<span class="badge ok">ok</span>'}</td>
    </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>table</th><th>policy</th><th>cmd</th><th>auth eval</th></tr></thead><tbody>${body}</tbody></table>`;
}

function metricsTable(a: Analysis): string {
  if (!a.metrics.available)
    return `<p class=empty>metrics endpoint not reachable (see collection notes)</p>`;
  if (!a.metrics.samples.length) return `<p class=empty>no curated samples</p>`;
  const rows = a.metrics.samples
    .map((s) => {
      const label = Object.entries(s.labels)
        .filter(
          ([k]) => !["supabase_project_ref", "supabase_identifier", "service_type"].includes(k),
        )
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `<tr><td class=mono>${esc(s.name)}</td><td class=mono>${esc(label)}</td><td>${esc(s.value)}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>metric</th><th>labels</th><th>value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function healthBadges(a: Analysis): string {
  if (!a.health.length) return `<p class=empty>unavailable</p>`;
  return a.health
    .map(
      (h) =>
        `<span class="badge ${h.healthy ? "ok" : "bad"}">${esc(h.name)}: ${esc(h.status)}</span>`,
    )
    .join(" ");
}

const SEV_CLASS: Record<Severity, string> = { high: "ERROR", med: "WARN", low: "INFO" };
function findingsSummary(findings: Finding[], degraded: boolean): string {
  if (!findings.length) {
    return degraded
      ? `<p class="banner">No findings - but diagnostics were incomplete (see status banner). Absence of findings here does not mean the project is clean.</p>`
      : `<p class="banner ok">No issues detected across performance, security, and capacity checks.</p>`;
  }
  const counts = { high: 0, med: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const lead = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${counts.high} high, ${counts.med} medium, ${counts.low} low`;
  const rows = findings
    .map(
      (f) => `<tr>
      <td><span class="lvl ${SEV_CLASS[f.severity]}">${f.severity.toUpperCase()}</span></td>
      <td>${esc(f.category)}</td>
      <td><a href="${f.anchor}">${esc(f.title)}</a></td>
    </tr>`,
    )
    .join("");
  return `<p class=lead>${esc(lead)}</p>
<table class=find><thead><tr><th>sev</th><th>area</th><th>finding</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Collapsible evidence section (open by default so PDF shows everything). */
function drill(id: string, title: string, note: string, body: string): string {
  return `<details open id="${id}"><summary><span class=h2>${esc(title)}</span>${note ? ` <span class=note>${esc(note)}</span>` : ""}</summary>${body}</details>`;
}

export function render(a: Analysis): string {
  const m = a.meta;
  const disk = a.disk;
  const errored = new Set(a.errors.map((e) => e.source));
  const findings = deriveFindings(a);

  // "not collected" (source errored) vs "none found" (collected, empty).
  // Key off the trivial dbSize probe: if that fails, the DB is unreachable;
  // a single fancy query failing does not mean the whole DB plane is down.
  const dbUnreachable = errored.has("sql:dbSize");
  const sec = (rows: SqlRow[], source: string, opts?: Parameters<typeof sqlTable>[1]) =>
    errored.has(source)
      ? `<p class="empty warn-text">not collected - see notes</p>`
      : sqlTable(rows, opts);

  const degraded = m.status !== "ACTIVE_HEALTHY" || dbUnreachable;
  const banner = degraded
    ? `<p class="banner bad">Project status <b>${esc(m.status)}</b>${dbUnreachable ? " - database was unreachable" : ""}. Runtime diagnostics (queries, metrics, health) are unavailable; only static config was collected. Empty sections below mean "not collected", not "clean".</p>`
    : "";

  const diskLine = disk
    ? `${disk.sizeGb} GB ${esc(disk.type)} / ${disk.iops ?? "-"} IOPS / ${disk.throughputMibps ?? "-"} MiB/s`
    : "-";
  const diskUsed =
    disk && disk.usedBytes != null
      ? `used ${bytes(disk.usedBytes)} / ${bytes((disk.usedBytes ?? 0) + (disk.availBytes ?? 0))}`
      : "";
  const up = a.upgrade;
  const upgradeNote =
    up?.current_app_version &&
    up.latest_app_version &&
    up.current_app_version !== up.latest_app_version
      ? `<span class="badge warn">update available</span>`
      : up
        ? `<span class="badge ok">up to date</span>`
        : "";

  const outliersNote = "app workload; platform/introspection queries filtered";
  const sections = `
<h2>Findings</h2>
${findingsSummary(findings, degraded)}

<h2>Service health</h2><p>${healthBadges(a)}</p>

<h2 id="infra">Infrastructure</h2>
<table class=kv>
  <tr><td>Postgres version</td><td class=mono>${esc(m.pgVersion)}</td><td>${upgradeNote}</td></tr>
  <tr><td>Disk</td><td class=mono>${diskLine}</td><td>${diskUsed}</td></tr>
  <tr><td>DB size</td><td class=mono>${esc(a.sql.dbSize ?? (errored.has("sql:dbSize") ? "not collected" : "-"))}</td><td></td></tr>
  <tr><td>Cache hit</td><td class=mono>${a.sql.cacheHitPct == null ? "-" : `${a.sql.cacheHitPct}%`}</td><td>${a.sql.cacheHitPct != null && a.sql.cacheHitPct < 99 ? '<span class="badge warn">below 99%</span>' : ""}</td></tr>
</table>

<h2 id="config">PG tuning params</h2>${errored.has("sql:pgSettings") ? '<p class="empty warn-text">not collected</p>' : pgSettingsTable(a.sql.pgSettings)}

${drill("rls", "RLS policies", "auth.*() should be wrapped: (select auth.uid())", errored.has("sql:rlsPolicies") ? '<p class="empty warn-text">not collected - see notes</p>' : rlsTable(a.sql.rlsPolicies))}

<h2 id="adv-perf">Advisors - performance <span class=count>${a.advisors.performance.length}</span></h2>${errored.has("advisors:performance") ? '<p class="empty warn-text">not collected</p>' : advisorTable(a.advisors.performance)}
<h2 id="adv-sec">Advisors - security <span class=count>${a.advisors.security.length}</span></h2>${errored.has("advisors:security") ? '<p class="empty warn-text">not collected</p>' : advisorTable(a.advisors.security)}

${drill("outliers", "Query outliers", outliersNote, sec(a.sql.topStatements, "sql:topStatements", { mono: ["query"], limit: 20 }))}
${drill("tables", "Biggest tables", "", sec(a.sql.biggestTables, "sql:biggestTables", { mono: ["table"], hide: ["schema"], limit: 20 }))}
${drill("unused", "Unused indexes", "idx_scan = 0, non-constraint", sec(a.sql.unusedIndexes, "sql:unusedIndexes", { mono: ["table", "index"], hide: ["schema"] }))}
${drill("seqscan", "Sequential-scan heavy", "seq_scan > idx_scan, >1k rows", sec(a.sql.seqScanHeavy, "sql:seqScanHeavy", { mono: ["table"], hide: ["schema"] }))}
${drill("deadtuples", "Dead tuples / autovacuum", "significant bloat only (>=1k dead, or >=100 & >=20%)", sec(a.sql.deadTuples, "sql:deadTuples", { mono: ["table"], hide: ["schema"] }))}
${drill("connections", "Connections", "by state", sec(a.sql.connections, "sql:connections"))}
${drill("apivol", "API request volume", "per interval", errored.has("apiCounts") ? '<p class="empty warn-text">not collected</p>' : sqlTable(a.apiCounts as unknown as SqlRow[], { mono: ["timestamp"] }))}
${drill("metrics", "Infra metrics", "point-in-time snapshot", metricsTable(a))}
${a.errors.length ? `<h2>Collection notes <span class=count>${a.errors.length}</span></h2>${collectionNotes(a)}` : ""}
`;

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>sbperf - ${esc(m.name)}</title>
<style>
  :root{--fg:#1a1a1a;--mut:#666;--line:#ddd;--bg:#fff;--accent:#3056d3;--okbg:#e3f4e3;--warnbg:#fff4d6;--errbg:#fde2e2}
  *{box-sizing:border-box}
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:24px;max-width:1200px}
  h1{font-size:20px;margin:0 0 4px}
  h2,.h2{font-size:15px;font-weight:700}
  h2{margin:26px 0 6px;padding-bottom:3px;border-bottom:2px solid var(--fg)}
  details{margin:26px 0 0}
  summary{border-bottom:2px solid var(--fg);padding-bottom:3px;cursor:pointer;list-style-position:inside}
  summary .h2{margin-right:4px}
  .meta{color:var(--mut);font-size:12px;margin-bottom:8px}
  .meta code{background:#f2f2f2;padding:1px 4px;border-radius:2px}
  .lead{font-weight:600;margin:6px 0}
  .banner{padding:8px 12px;border-radius:4px;font-size:13px;margin:8px 0}
  .banner.bad{background:var(--errbg)}.banner.ok{background:var(--okbg)}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin:2px 0}
  th,td{text-align:left;padding:4px 8px;border:1px solid var(--line);vertical-align:top}
  th{background:#f6f6f6;font-weight:600;white-space:nowrap}
  tbody tr:nth-child(even){background:#fafafa}
  tbody tr.flag{background:var(--warnbg)}
  td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;max-width:620px;word-break:break-word}
  table.kv{table-layout:fixed}
  table.kv td:first-child{white-space:nowrap;font-weight:600;width:130px}
  table.kv td:nth-child(3){width:34%;word-break:break-word}
  table.find td:first-child,table.find td:nth-child(2){white-space:nowrap;width:1%}
  .count{display:inline-block;background:var(--fg);color:#fff;border-radius:10px;padding:0 7px;font-size:11px;vertical-align:middle}
  .note{color:var(--mut);font-weight:400;font-size:12px}
  .empty{color:var(--mut);font-style:italic;margin:4px 0}
  .warn-text{color:#8a6d00}
  .lvl{font-weight:700;font-size:11px;padding:1px 5px;border-radius:2px}
  .lvl.WARN{background:var(--warnbg)}.lvl.ERROR{background:var(--errbg)}.lvl.INFO{background:#e6f0ff}
  .badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:3px;background:#eee}
  .badge.ok{background:var(--okbg)}.badge.warn{background:var(--warnbg)}.badge.bad{background:var(--errbg)}
  table.adv td:nth-child(3){max-width:560px}
  a{color:var(--accent)}
  @page{size:A4;margin:14mm 12mm}
  @media print{body{padding:0;max-width:none}h2,summary{page-break-after:avoid}tr{page-break-inside:avoid}details{page-break-inside:auto}}
</style></head><body>
<h1>Supabase performance report</h1>
<div class=meta>
  <code>${esc(m.name)}</code> (${esc(m.ref)}) &middot; ${esc(m.region)} &middot;
  status <code>${esc(m.status)}</code> &middot;
  collected <code>${esc(m.collectedAt)}</code> &middot;
  transport <code>${esc(m.transport)}</code> &middot; sbperf <code>${esc(m.sbperfVersion)}</code>
</div>
${banner}
${sections}
<p class=meta style="margin-top:32px">Generated deterministically from the Supabase Management API, read-only SQL, and the project metrics endpoint. No values inferred.</p>
</body></html>`;
}

/** Dedup identical error messages (e.g. 8x connection-timeout) into one row + count. */
function collectionNotes(a: Analysis): string {
  const byMsg = new Map<string, { sources: string[]; message: string }>();
  for (const e of a.errors) {
    const g = byMsg.get(e.message) ?? { sources: [], message: e.message };
    g.sources.push(e.source);
    byMsg.set(e.message, g);
  }
  const rows = [...byMsg.values()]
    .map(
      (g) =>
        `<tr><td class=mono>${esc(g.sources.length > 3 ? `${g.sources.slice(0, 3).join(", ")} +${g.sources.length - 3}` : g.sources.join(", "))}</td><td>${esc(g.message)}${g.sources.length > 1 ? ` <span class=count>${g.sources.length}x</span>` : ""}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>source</th><th>message</th></tr></thead><tbody>${rows}</tbody></table>`;
}
