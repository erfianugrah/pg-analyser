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

/** Render an array of row objects as a table, inferring columns from the first row. */
function sqlTable(rows: SqlRow[], opts: { mono?: string[]; limit?: number } = {}): string {
  if (!rows.length) return `<p class=empty>none</p>`;
  const cols = Object.keys(rows[0]!);
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

/** A handful of perf-relevant PG config params, if present. */
const PG_KEYS = [
  "max_connections",
  "shared_buffers",
  "effective_cache_size",
  "work_mem",
  "maintenance_work_mem",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
];
function pgConfigTable(cfg: Record<string, unknown> | null): string {
  if (!cfg) return `<p class=empty>unavailable</p>`;
  const rows = PG_KEYS.filter((k) => k in cfg).map(
    (k) => `<tr><td class=mono>${esc(k)}</td><td class=mono>${esc(cfg[k])}</td></tr>`,
  );
  if (!rows.length) return `<p class=empty>no tuning params exposed by the API</p>`;
  return `<table><thead><tr><th>parameter</th><th>value</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
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

/** Render an Analysis into a single self-contained HTML document. */
export function render(a: Analysis): string {
  const m = a.meta;
  const disk = a.disk;
  const diskUsed =
    disk && disk.usedBytes != null && disk.usedBytes + (disk.availBytes ?? 0) > 0
      ? `${bytes(disk.usedBytes)} / ${bytes((disk.usedBytes ?? 0) + (disk.availBytes ?? 0))}`
      : "-";
  const up = a.upgrade;
  const upgradeNote =
    up?.current_app_version &&
    up.latest_app_version &&
    up.current_app_version !== up.latest_app_version
      ? `<span class="badge warn">${esc(up.current_app_version)} -> ${esc(up.latest_app_version)} available</span>`
      : up
        ? `<span class="badge ok">up to date</span>`
        : "-";

  const sections = `
<h2>Service health</h2><p>${healthBadges(a)}</p>

<h2>Infrastructure <span class=note>perf-relevant</span></h2>
<table class=kv>
  <tr><td>Postgres version</td><td class=mono>${esc(m.pgVersion)}</td><td>${upgradeNote}</td></tr>
  <tr><td>Disk</td><td class=mono>${disk ? `${disk.sizeGb} GB ${esc(disk.type)} / ${disk.iops ?? "-"} IOPS / ${disk.throughputMibps ?? "-"} MiB/s` : "-"}</td><td>used ${diskUsed}</td></tr>
  <tr><td>Pooler</td><td class=mono>${a.pooler?.[0] ? `${esc(a.pooler[0].pool_mode)} :${a.pooler[0].db_port}` : "-"}</td><td></td></tr>
  <tr><td>DB size</td><td class=mono>${esc(a.sql.dbSize)}</td><td></td></tr>
  <tr><td>Cache hit</td><td class=mono>${a.sql.cacheHitPct == null ? "-" : `${a.sql.cacheHitPct}%`}</td><td>${a.sql.cacheHitPct != null && a.sql.cacheHitPct < 99 ? '<span class="badge warn">below 99%</span>' : ""}</td></tr>
</table>

<h2>PG tuning params</h2>${pgConfigTable(a.pgConfig)}

<h2>Advisors - performance <span class=count>${a.advisors.performance.length}</span></h2>${advisorTable(a.advisors.performance)}
<h2>Advisors - security <span class=count>${a.advisors.security.length}</span></h2>${advisorTable(a.advisors.security)}

<h2>Query outliers <span class=note>pg_stat_statements, by total exec time</span></h2>${sqlTable(a.sql.topStatements, { mono: ["query"], limit: 20 })}
<h2>Biggest tables</h2>${sqlTable(a.sql.biggestTables, { mono: ["table"], limit: 20 })}
<h2>Unused indexes <span class=note>idx_scan = 0, non-constraint</span></h2>${sqlTable(a.sql.unusedIndexes, { mono: ["table", "index"] })}
<h2>Sequential-scan heavy <span class=note>seq_scan &gt; idx_scan, &gt;1k rows</span></h2>${sqlTable(a.sql.seqScanHeavy, { mono: ["table"] })}
<h2>Dead tuples <span class=note>MVCC bloat</span></h2>${sqlTable(a.sql.deadTuples, { mono: ["table"] })}
<h2>Connections <span class=note>by state</span></h2>${sqlTable(a.sql.connections)}
<h2>API request volume <span class=note>per interval</span></h2>${sqlTable(a.apiCounts as unknown as SqlRow[], { mono: ["timestamp"] })}
<h2>Infra metrics <span class=note>point-in-time snapshot</span></h2>${metricsTable(a)}
${a.errors.length ? `<h2>Collection notes <span class=count>${a.errors.length}</span></h2>${sqlTable(a.errors as unknown as SqlRow[], { mono: ["source"] })}` : ""}
`;

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>sbperf - ${esc(m.name)}</title>
<style>
  :root{--fg:#1a1a1a;--mut:#666;--line:#ddd;--bg:#fff;--accent:#3056d3;--okbg:#e3f4e3;--warnbg:#fff4d6;--errbg:#fde2e2}
  *{box-sizing:border-box}
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:24px;max-width:1200px}
  h1{font-size:20px;margin:0 0 4px}
  h2{font-size:15px;margin:26px 0 6px;padding-bottom:3px;border-bottom:2px solid var(--fg)}
  .meta{color:var(--mut);font-size:12px;margin-bottom:8px}
  .meta code{background:#f2f2f2;padding:1px 4px;border-radius:2px}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin:2px 0}
  th,td{text-align:left;padding:4px 8px;border:1px solid var(--line);vertical-align:top}
  th{background:#f6f6f6;font-weight:600;white-space:nowrap}
  tbody tr:nth-child(even){background:#fafafa}
  td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;max-width:620px;word-break:break-word}
  table.kv td:first-child{white-space:nowrap;font-weight:600;width:140px}
  .count{display:inline-block;background:var(--fg);color:#fff;border-radius:10px;padding:0 7px;font-size:11px;vertical-align:middle}
  .note{color:var(--mut);font-weight:400;font-size:12px}
  .empty{color:var(--mut);font-style:italic;margin:4px 0}
  .lvl{font-weight:700;font-size:11px;padding:1px 5px;border-radius:2px}
  .lvl.WARN{background:var(--warnbg)}.lvl.ERROR{background:var(--errbg)}.lvl.INFO{background:#e6f0ff}
  .badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:3px;background:#eee}
  .badge.ok{background:var(--okbg)}.badge.warn{background:var(--warnbg)}.badge.bad{background:var(--errbg)}
  table.adv td:nth-child(3){max-width:560px}
  a{color:var(--accent)}
  @page{size:A4;margin:14mm 12mm}
  @media print{body{padding:0;max-width:none}h2{page-break-after:avoid}tr{page-break-inside:avoid}}
</style></head><body>
<h1>Supabase performance report</h1>
<div class=meta>
  <code>${esc(m.name)}</code> (${esc(m.ref)}) &middot; ${esc(m.region)} &middot;
  status <code>${esc(m.status)}</code> &middot;
  collected <code>${esc(m.collectedAt)}</code> &middot;
  transport <code>${esc(m.transport)}</code> &middot; sbperf <code>${esc(m.sbperfVersion)}</code>
</div>
${sections}
<p class=meta style="margin-top:32px">Generated deterministically from the Supabase Management API, read-only SQL, and the project metrics endpoint. No values inferred.</p>
</body></html>`;
}
