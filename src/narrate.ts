import { deriveFindings, derivePositives } from "./findings.ts";
import type { Analysis, SqlRow } from "./schemas.ts";
import { sufficient, trendStat } from "./trendstats.ts";

/**
 * `narrate` - the LLM pass over the collected corpus + the enriched findings.
 *
 * Design: the deterministic report is ground truth; narrate SYNTHESIZES prose
 * from it, it does not re-derive facts. We hand the model (a) the ranked
 * findings WITH their catalogued remediation + doc URL, (b) the confirmed-
 * healthy positives, and (c) a bounded evidence digest of the raw diagnostics
 * (top query outliers, biggest tables, index/RLS/vacuum signals, connections,
 * latest trend values, the curated metric slice). The system prompt forbids
 * inventing thresholds or facts - the model may only quote what it is given and
 * cite the provided doc URLs. This keeps the narrative grounded and auditable.
 *
 * The corpus is large (~850 metric samples + many SQL rows); we send a bounded
 * digest, not the whole thing, so it fits a normal context window. The full
 * corpus stays in analysis.json for anyone who wants to go deeper.
 */

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

/** Minimal chat-completion client so tests can inject a fake. */
export interface LlmClient {
  model: string;
  complete(messages: LlmMessage[]): Promise<string>;
}

const truncate = (s: unknown, n: number): string => {
  const str = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return str.length > n ? `${str.slice(0, n)}...` : str;
};

const publicRows = (rows: SqlRow[]): SqlRow[] =>
  rows.filter((r) => String(r.schema ?? "") === "public");

/**
 * Bounded, JSON-serialisable digest of an Analysis for the model. Pure and
 * deterministic - unit-tested independently of any LLM.
 */
/** Grounded JSON payload handed to the LLM; shape inferred and re-exported for tests. */
export type NarrativeInput = ReturnType<typeof buildNarrativeInput>;

export function buildNarrativeInput(a: Analysis) {
  const findings = deriveFindings(a).map((f) => ({
    severity: f.severity,
    category: f.category,
    title: f.title,
    whyItMatters: f.whyItMatters,
    remediation: f.remediation,
    doc: f.docUrl,
    changelog: f.changelogUrl,
  }));
  const positives = derivePositives(a).map((p) => `${p.category}: ${p.title}`);

  const outliers = a.sql.topStatements.slice(0, 8).map((r) => ({
    query: truncate(r.query, 160),
    pct_db_time: r.pct ?? null,
    calls: r.calls ?? null,
    mean_ms: r.mean_ms ?? null,
  }));
  const frequent = a.sql.topByCalls.slice(0, 6).map((r) => ({
    query: truncate(r.query, 120),
    pct_calls: r.pct_calls ?? null,
    calls: r.calls ?? null,
  }));
  const tables = a.sql.biggestTables.slice(0, 8).map((r) => ({
    table: r.table,
    size: r.total_size ?? r.size ?? null,
  }));
  // Full trend shape so the model reasons over the TRAJECTORY (headroom,
  // direction, projection), not just the last value. `sufficient` tells it when
  // the window is trustworthy for sustained/projection claims.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const trends = a.trends.map((t) => {
    const s = trendStat(t.points);
    return {
      title: t.title,
      unit: t.unit,
      points: t.points.length,
      spanDays: s ? r2(s.spanDays) : 0,
      latest: s ? r2(s.last) : null,
      mean: s ? r2(s.mean) : null,
      min: s ? r2(s.min) : null,
      max: s ? r2(s.max) : null,
      p95: s ? r2(s.p95) : null,
      perDay: s ? r2(s.slopePerDay) : null,
      direction: s?.direction ?? null,
      sufficient: sufficient(t.points),
    };
  });

  return {
    project: {
      name: a.meta.name,
      region: a.meta.region,
      status: a.meta.status,
      pgVersion: a.meta.pgVersion,
      dbSize: a.sql.dbSize,
      cacheHitPct: a.sql.cacheHitPct,
      indexHitPct: a.sql.indexHitPct,
      statsWindow: a.sql.statsResetAge,
      disk: a.disk,
      sqlSource: a.meta.sqlSource,
      // false = no-PAT mode: no Management API (provisioning/backups/metrics/
      // analytics absent); SQL + splinter advisors + Grafana trends are the evidence.
      managementApi: a.meta.managementApi !== false,
    },
    // Report the collection health so the model can caveat gaps honestly. In
    // no-PAT mode the status is simply unknown (not degraded) - gate on it only
    // when the Management API was available.
    degraded:
      (a.meta.managementApi !== false && a.meta.status !== "ACTIVE_HEALTHY") ||
      a.errors.some((e) => e.source === "sql:dbSize"),
    collectionNotes: a.errors.slice(0, 12),
    findings,
    positives,
    evidence: {
      queryOutliers: outliers,
      frequentQueries: frequent,
      biggestTables: tables,
      unusedIndexes: publicRows(a.sql.indexStats).filter((r) => r.unused === true).length,
      duplicateIndexes: publicRows(a.sql.duplicateIndexes).length,
      rlsUnindexedColumns: publicRows(a.sql.rlsUnindexed).map((r) => `${r.table}.${r.column}`),
      seqScanHeavy: a.sql.seqScanHeavy.slice(0, 6),
      bloat: a.sql.bloat.slice(0, 5),
      connections: a.sql.connections,
      roleStats: a.sql.roleStats.slice(0, 6),
      functionStats: a.functionStats.slice(0, 8),
      advisors: {
        performance: a.advisors.performance.length,
        security: a.advisors.security.length,
      },
    },
    trends,
    sync: a.sync,
  };
}

const SYSTEM_PROMPT = `You are a senior Supabase/Postgres performance and cost engineer writing the ANALYSIS section of a database audit report shared with a customer. You are given a JSON object with the project's facts: ranked findings (each with why it matters, remediation, how to verify, a doc URL, and sometimes a changelog URL for a known platform change), healthy observations, and a bounded evidence digest (top query outliers, metrics, trends). The report ALREADY renders the structured findings, the healthy list, and the resource charts below your section - your job is the analytical layer on top: synthesise, prioritise, and review the tool's findings, adding the reasoning and cross-cutting insight the raw finding cards lack.

Grounding (hard rules):
- Ground every statement in the supplied JSON. Do NOT invent numbers, thresholds, table names, durations, timeouts, percentages, or URLs. If something is unknown, leave it out.
- You may reference the catalogued why/verify/remediation and the evidence digest. Cite a doc URL only if it is present in the JSON; never fabricate one.
- TRENDS: each trend carries mean/min/max/p95, a per-day slope, a direction (rising/falling/flat) and the window span in days. Reason over the TRAJECTORY - headroom vs pressure, where it's heading, whether a resource is over- or under-provisioned - not just the latest value. A trend also has a "sufficient" flag: when false the window is too short/sparse to trust, so do NOT make sustained-% or days-to-full claims from it (say the history is too short instead). Never extrapolate a projection much past the span you were given.
- NO-PAT MODE: if project.managementApi is false, there was no Supabase Management API - compute/disk provisioning, backups, pooler config, the point-in-time metrics scrape and edge/API analytics were NOT collected. Do not comment on them or claim they're healthy; base the analysis on the SQL diagnostics, the splinter advisors, and the Grafana trends. Disk provisioning (size/IOPS) is unknown, but disk-used% is available from the trend.
- Some findings carry a "changelog" URL: a documented Supabase platform change or known issue behind the finding (e.g. a default that changed). When present, reference it - it is the authoritative "this is a known change, here is the background" link the reader wants. Same rule as doc URLs: cite the changelog only if it is present in the JSON for that finding; never invent or guess one.
- Be concrete, not vague. When a finding's remediation names a specific recommended value or target - a timeout, a size, a percentage, a fraction, a starting figure - carry that exact value into your prose. Do NOT flatten "set statement_timeout to something like 30s-60s" into "set a statement_timeout", or "raise work_mem toward 16-64MB" into "raise work_mem". The reader's complaint is being told what is wrong but not what to set it to; the values are in the remediation, so surface them. Never invent a value the remediation does not give.
- If "degraded" is true or there are collectionNotes, say plainly that some checks could not run and the absence of a finding is not proof of health.

Tone - conversational, observational, understated. Write like a colleague talking through what they saw, not a consultant issuing orders:
- No imperative openers (Address / Fix / Tackle / Prioritise / Start with / Focus on) and no modal directives (should / must / need to). The closest you get is "you might want to ..." / "it may be worth ...".
- No self-assured framings ("the single most important thing", "we recommend", "the obvious next step"). No time-bounded directives (this week / this sprint) and no PM vocabulary (action items / roadmap / effort).
- Outcomes are always conditional - could / would / may / might, never will / is going to.
- Plain language for a developer who is not a DBA. Keep Postgres jargon out of the prose; "index" is fine. SQL only inside fenced code blocks.

Output GitHub-flavoured Markdown with these sections (use these exact ## headings). Length is proportionate to the findings: a genuinely healthy database stays brief; a busy one earns a few paragraphs. Never pad.

## Executive summary
2-4 sentences for a non-technical lead: overall posture, the one or two themes worth attention (named, grounded), and the conditional upside. Do not open with "Your database" or "This database" - start with the observation ("Overall the database is in good shape ...").

## What stands out
The findings in the order you would look at them, with the REASONING the cards do not carry: why this order, what compounds what (e.g. an unindexed column on a hot table also showing up in the query outliers), the cost/capacity read (headroom vs pressure across compute/memory/disk/IOPS/connections), and where the data suggests something is lower concern than its severity label. Reference findings by name. Where a remediation gives a concrete target value, name it here too so the reader leaves knowing what to set, not just what is wrong. A short prose-with-inline-emphasis treatment or a tight bulleted list, whichever fits.

## Notes on the findings (optional)
Only if you can add real value: bolster or temper specific findings using the evidence digest - confirm a finding matters given the actual scale/metrics, connect related ones, or add the one line of context that makes the fix land. No SQL dumps (the cards have those); at most a short illustrative snippet. Omit this section entirely if you have nothing to add beyond the cards.

Do not reproduce the healthy list or the charts (they render elsewhere). Do not mention missing files, data windows, or confidence levels.`;

export function buildMessages(a: Analysis): LlmMessage[] {
  const input = buildNarrativeInput(a);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Write the analysis for this project audit.\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
    },
  ];
}

/** Run the LLM pass and return the narrative markdown. */
export async function narrate(a: Analysis, client: LlmClient): Promise<string> {
  const text = (await client.complete(buildMessages(a))).trim();
  if (!text) throw new Error("LLM returned an empty narrative");
  const header = `<!-- generated by sbperf narrate (${client.model}) from analysis.json; the deterministic report.html is ground truth -->\n\n`;
  return `${header}${text}\n`;
}

/** OpenAI-compatible chat-completions client (OpenAI, local llama-server, ...). */
export class OpenAiCompatClient implements LlmClient {
  constructor(
    readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(messages: LlmMessage[]): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, messages, temperature: 0.2, stream: false }),
    });
    if (!res.ok) {
      throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM response had no message content");
    return content;
  }
}

/**
 * Build a client from env, or return a clear error string when unconfigured.
 * SBPERF_LLM_BASE_URL + SBPERF_LLM_MODEL required; SBPERF_LLM_API_KEY optional
 * (local llama-server needs none). Never throws - returns {error} so the CLI
 * can print actionable guidance.
 */
export function clientFromEnv(
  env: Record<string, string | undefined> = process.env,
): { client: LlmClient } | { error: string } {
  const baseUrl = env.SBPERF_LLM_BASE_URL;
  const model = env.SBPERF_LLM_MODEL;
  if (!baseUrl || !model) {
    return {
      error:
        "narrate needs an LLM: set SBPERF_LLM_BASE_URL (e.g. http://localhost:11434/v1 or " +
        "https://api.openai.com/v1) and SBPERF_LLM_MODEL (SBPERF_LLM_API_KEY if the endpoint " +
        "requires a key).",
    };
  }
  return { client: new OpenAiCompatClient(baseUrl, model, env.SBPERF_LLM_API_KEY) };
}
