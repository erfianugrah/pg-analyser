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

function functionsSection(a: Analysis): string {
  if (!a.functions.length) return "<p class=empty>none deployed</p>";
  const list = sqlTable(a.functions as unknown as SqlRow[], { mono: ["slug"], hide: ["id"] });
  if (!a.functionStats.length) return list;
  const stats = a.functionStats.map((s) => ({
    slug: s.slug,
    requests: s.requests,
    success: s.success,
    "4xx": s.clientErr,
    "5xx": s.serverErr,
    avg_ms: s.avgExecMs,
    max_ms: s.maxExecMs,
  }));
  return `${list}<p class=note>Invocation stats (last day)</p>${sqlTable(stats as unknown as SqlRow[], { mono: ["slug"] })}`;
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

const fmtVal = (v: number, unit: string): string =>
  unit === "bytes" ? bytes(v) : v < 10 ? v.toFixed(2) : String(Math.round(v));

/** Inline SVG sparkline for one trend series - self-contained, no external assets. */
function sparkline(s: Analysis["trends"][number]): string {
  const w = 340;
  const h = 70;
  const pad = 4;
  const vals = s.points.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = s.points.length;
  const x = (i: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - 2 * pad));
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const path = s.points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const last = s.points[n - 1]?.v ?? 0;
  return `<figure class=spark>
    <figcaption>${esc(s.title)} <b>${esc(fmtVal(last, s.unit))}</b></figcaption>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <path d="${path}" fill="none" stroke="#3056d3" stroke-width="1.5"/>
    </svg>
    <span class=note>${esc(fmtVal(min, s.unit))} - ${esc(fmtVal(max, s.unit))} over ${n} pts</span>
  </figure>`;
}

function trendsSection(a: Analysis): string {
  if (!a.trends.length) return "";
  return `<h2 id="trends">30-day trends <span class=note>from Prometheus scraper</span></h2>
<div class=sparks>${a.trends.map(sparkline).join("")}</div>`;
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

export interface IndexRow {
  name: string;
  ref: string;
  status: string;
  high: number;
  med: number;
  low: number;
  dir: string;
  error?: string;
}

/** Org-level index page linking every project report. */
export function renderIndex(rows: IndexRow[], collectedAt: string): string {
  const body = rows
    .map((r) => {
      const healthy = r.status === "ACTIVE_HEALTHY";
      const sev =
        r.error != null
          ? '<span class="lvl ERROR">ERROR</span>'
          : r.high > 0
            ? '<span class="lvl ERROR">high</span>'
            : r.med > 0
              ? '<span class="lvl WARN">med</span>'
              : '<span class="lvl INFO">low</span>';
      return `<tr>
      <td><a href="${esc(r.dir)}/report.html">${esc(r.name)}</a></td>
      <td class=mono>${esc(r.ref)}</td>
      <td><span class="badge ${healthy ? "ok" : "bad"}">${esc(r.status)}</span></td>
      <td>${r.error ? esc(r.error) : `${r.high} / ${r.med} / ${r.low}`}</td>
      <td>${sev}</td>
    </tr>`;
    })
    .join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>sbperf - org report</title>
<style>
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;margin:0 auto;padding:24px;max-width:1000px}
  h1{font-size:20px;margin:0 0 4px}.meta{color:#666;font-size:12px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{text-align:left;padding:5px 9px;border:1px solid #ddd}
  th{background:#f6f6f6}tbody tr:nth-child(even){background:#fafafa}
  td.mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
  .badge{font-size:11px;padding:1px 6px;border-radius:3px}.badge.ok{background:#e3f4e3}.badge.bad{background:#fde2e2}
  .lvl{font-weight:700;font-size:11px;padding:1px 5px;border-radius:2px}
  .lvl.WARN{background:#fff4d6}.lvl.ERROR{background:#fde2e2}.lvl.INFO{background:#e6f0ff}
  a{color:#3056d3}
</style></head><body>
<h1>Supabase performance - org report</h1>
<div class=meta>${rows.length} projects &middot; collected ${esc(collectedAt)} &middot; findings shown as high / med / low</div>
<table><thead><tr><th>project</th><th>ref</th><th>status</th><th>findings</th><th>top sev</th></tr></thead><tbody>${body}</tbody></table>
</body></html>`;
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
${trendsSection(a)}

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
${drill("calls", "Most-frequent queries", "by call count - chatty / hot-path (noise filtered)", sec(a.sql.topByCalls, "sql:topByCalls", { mono: ["query"], limit: 20 }))}
${drill("tables", "Biggest tables", "", sec(a.sql.biggestTables, "sql:biggestTables", { mono: ["table"], hide: ["schema"], limit: 20 }))}
${drill("unused", "Unused indexes", "idx_scan = 0, non-constraint", sec(a.sql.unusedIndexes, "sql:unusedIndexes", { mono: ["table", "index"], hide: ["schema"] }))}
${drill("seqscan", "Sequential-scan heavy", "seq_scan > idx_scan, >1k rows", sec(a.sql.seqScanHeavy, "sql:seqScanHeavy", { mono: ["table"], hide: ["schema"] }))}
${drill("deadtuples", "Dead tuples / autovacuum", "significant bloat only (>=1k dead, or >=100 & >=20%)", sec(a.sql.deadTuples, "sql:deadTuples", { mono: ["table"], hide: ["schema"] }))}
${drill("txid", "Transaction-ID wraparound", "age(relfrozenxid) vs 2B ceiling; non-system tables", sec(a.sql.txidWraparound, "sql:txidWraparound", { mono: ["table"], hide: ["schema"] }))}
${drill("slots", "Replication slots", "retained WAL; inactive slots pin disk", a.sql.replicationSlots.length ? sqlTable(a.sql.replicationSlots, { mono: ["slot_name"], hide: ["retained_wal_bytes"] }) : "<p class=empty>none</p>")}
${drill("connections", "Connections", "by state", sec(a.sql.connections, "sql:connections"))}
${drill("functions", "Edge functions", "invocation stats over the last day", functionsSection(a))}
${drill("storage", "Storage", "buckets + object usage", storageSection(a))}
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
  .sparks{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 18px;margin-top:8px}
  figure.spark{margin:0}
  figure.spark figcaption{font-size:12px;font-weight:600}
  figure.spark svg{border:1px solid var(--line);background:#fafafa}
  @page{size:A4;margin:14mm 12mm}
  @media print{body{padding:0;max-width:none}h2,summary{page-break-after:avoid}tr{page-break-inside:avoid}details{page-break-inside:auto}}
</style></head><body>
<h1>Supabase performance report</h1>
<div class=meta>
  <code>${esc(m.name)}</code> (${esc(m.ref)}) &middot; ${esc(m.region)} &middot;
  status <code>${esc(m.status)}</code> &middot;
  collected <code>${esc(m.collectedAt)}</code> &middot; sbperf <code>${esc(m.sbperfVersion)}</code>
</div>
${banner}
${sections}
<p class=meta style="margin-top:32px">Generated deterministically from the Supabase Management API, read-only SQL, and the project metrics endpoint. No values inferred.</p>
</body></html>`;
}

/**
 * Non-technical, one-page summary for a non-engineering audience. No SQL, no
 * evidence tables - a plain verdict, the issues in priority order, and a few
 * vitals in everyday terms. Companion to the full technical report.
 */
export function renderSummary(a: Analysis): string {
  const m = a.meta;
  const findings = deriveFindings(a);
  const degraded = a.meta.status !== "ACTIVE_HEALTHY" || !a.metrics.available;
  const counts = { high: 0, med: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  const verdict = !findings.length
    ? degraded
      ? { cls: "warn", text: "No issues found, but some checks could not run" }
      : { cls: "ok", text: "Healthy - no issues found" }
    : counts.high > 0
      ? {
          cls: "bad",
          text: `${counts.high} issue${counts.high === 1 ? " needs" : "s need"} attention now`,
        }
      : {
          cls: "warn",
          text: `${findings.length} issue${findings.length === 1 ? "" : "s"} worth reviewing`,
        };

  const label: Record<Severity, string> = {
    high: "Needs attention now",
    med: "Worth reviewing",
    low: "Minor / housekeeping",
  };
  const groups = (["high", "med", "low"] as const)
    .map((sev) => {
      const items = findings.filter((f) => f.severity === sev);
      if (!items.length) return "";
      const li = items.map((f) => `<li><b>${esc(f.category)}:</b> ${esc(f.title)}</li>`).join("");
      return `<h2 class="g ${SEV_CLASS[sev]}">${label[sev]}</h2><ul>${li}</ul>`;
    })
    .join("");

  const cacheText =
    a.sql.cacheHitPct == null
      ? "not measured"
      : a.sql.cacheHitPct >= 99
        ? `${a.sql.cacheHitPct}% of reads served from memory (healthy)`
        : `${a.sql.cacheHitPct}% of reads served from memory (below the 99% target)`;

  const vitals = [
    ["Database size", esc(a.sql.dbSize ?? "not measured")],
    ["Read cache", cacheText],
    ["Postgres version", esc(m.pgVersion ?? "unknown")],
  ]
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("");

  const body = findings.length
    ? groups
    : `<p>All performance, security, and capacity checks passed${degraded ? ", though some data could not be collected (the project may be paused or unreachable)" : ""}.</p>`;

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(m.name)} - performance summary</title>
<style>
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;background:#fff;margin:0 auto;padding:32px;max-width:760px}
  h1{font-size:22px;margin:0 0 2px}
  .meta{color:#666;font-size:13px;margin-bottom:16px}
  .verdict{padding:14px 16px;border-radius:6px;font-size:17px;font-weight:600;margin:12px 0 20px}
  .verdict.ok{background:#e3f4e3}.verdict.warn{background:#fff4d6}.verdict.bad{background:#fde2e2}
  h2.g{font-size:14px;margin:20px 0 4px;padding:2px 8px;border-radius:3px;display:inline-block}
  h2.g.ERROR{background:#fde2e2}h2.g.WARN{background:#fff4d6}h2.g.INFO{background:#e6f0ff}
  ul{margin:4px 0 0;padding-left:22px}li{margin:3px 0}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:14px}
  td{padding:6px 10px;border:1px solid #ddd}td:first-child{font-weight:600;width:180px}
  .foot{color:#666;font-size:12px;margin-top:28px}
  @page{size:A4;margin:16mm}
</style></head><body>
<h1>Performance summary</h1>
<div class=meta>${esc(m.name)} &middot; ${esc(m.region)} &middot; ${esc(m.collectedAt.slice(0, 10))}</div>
<div class="verdict ${verdict.cls}">${esc(verdict.text)}</div>
${body}
<h2 class=g>At a glance</h2>
<table><tbody>${vitals}</tbody></table>
<p class=foot>Plain-language summary. A detailed technical report (report.html) accompanies this for the engineering team. Generated by sbperf ${esc(m.sbperfVersion)}.</p>
</body></html>`;
}

function storageSection(a: Analysis): string {
  if (!a.buckets.length) return `<p class=empty>no buckets</p>`;
  const usage = new Map<string, SqlRow>();
  for (const r of a.sql.storageUsage) usage.set(String(r.bucket_id), r);
  const body = a.buckets
    .map((b) => {
      const u = usage.get(b.name);
      return `<tr><td class=mono>${esc(b.name)}</td><td>${b.public ? '<span class="badge warn">public</span>' : '<span class="badge ok">private</span>'}</td><td>${esc(u?.objects ?? 0)}</td><td>${esc(u?.size ?? "0 bytes")}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>bucket</th><th>access</th><th>objects</th><th>size</th></tr></thead><tbody>${body}</tbody></table>`;
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
