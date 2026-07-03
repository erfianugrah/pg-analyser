import { deriveFindings, derivePositives } from "./findings.ts";
import type { Analysis, SqlRow } from "./schemas.ts";

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
export function buildNarrativeInput(a: Analysis): Record<string, unknown> {
  const findings = deriveFindings(a).map((f) => ({
    severity: f.severity,
    category: f.category,
    title: f.title,
    whyItMatters: f.whyItMatters,
    remediation: f.remediation,
    doc: f.docUrl,
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
  const trends = a.trends.map((t) => ({
    title: t.title,
    latest: t.points.at(-1)?.v ?? null,
    unit: t.unit,
    points: t.points.length,
  }));

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
    },
    // Report the collection health so the model can caveat gaps honestly.
    degraded: a.meta.status !== "ACTIVE_HEALTHY" || a.errors.some((e) => e.source === "sql:dbSize"),
    collectionNotes: a.errors.slice(0, 12),
    findings,
    positives,
    evidence: {
      queryOutliers: outliers,
      frequentQueries: frequent,
      biggestTables: tables,
      unusedIndexes: publicRows(a.sql.indexStats).filter((r) => r.unused === true).length,
      duplicateIndexes: publicRows(a.sql.duplicateIndexes).length,
      rlsUnindexedColumns: publicRows(a.sql.rlsUnindexed).map((r) => r.table + "." + r.column),
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

const SYSTEM_PROMPT = `You are a senior Supabase/Postgres performance and cost engineer writing the EXECUTIVE SUMMARY for a database audit report that will be shared with a customer. You are given a JSON object with the project's facts: ranked findings (each with why it matters, remediation, and a doc URL), healthy observations, and a bounded evidence digest. The rest of the report already lists the findings, what's looking good, and the resource charts - your job is ONLY the short executive summary prose that sits at the top.

Grounding:
- Ground every statement in the supplied JSON. Do NOT invent numbers, thresholds, table names, durations, timeouts, percentages, or URLs. If something is unknown, leave it out.
- If "degraded" is true or there are collectionNotes, note plainly that some checks could not run and that the absence of a finding is not proof of health.

Tone - conversational, observational, understated. Write like a colleague sharing what they saw, not a consultant issuing orders:
- No imperative openers (Address / Fix / Tackle / Prioritise / Start with / Focus on).
- No modal directives (should / must / need to / have to / ought to). The closest you get is "you might want to ..." or "it may be worth ...".
- No self-assured framings ("the single most important thing", "we recommend", "the obvious next step", "clearly the biggest issue").
- No time-bounded directives (this week / this sprint / next 30 days) and no project-management vocabulary (action items / roadmap / prioritisation / effort).
- Outcomes are always conditional - could / would / may / might, never will / is going to.
- Plain language for a developer who is not a DBA. Keep Postgres jargon out of the prose; "index" is fine.

Preferred openings: "Overall the database is in good shape ...", "The infrastructure has plenty of headroom ...", "There are a couple of areas worth a closer look - ...". Do not open with "Your database" or "This database".

Output GitHub-flavoured Markdown, and ONLY the executive summary:
- 3-5 sentences of prose (2 is fine if the database is genuinely healthy - do not pad): overall posture, the one or two areas worth attention (name them, grounded in the findings), and the conditional upside of addressing them.
- Optionally end with a short list under "**A few things worth a closer look:**" naming the top findings in plain language, one line each, no SQL.
- Do NOT emit a top-level heading (the report adds "Executive summary"). Do NOT reproduce the full findings, the healthy list, or the charts - those already appear elsewhere in the report.
- Do not mention missing files, data windows, coverage, or confidence levels.`;

export function buildMessages(a: Analysis): LlmMessage[] {
  const input = buildNarrativeInput(a);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Write the executive summary for this project audit.\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
    },
  ];
}

/** Run the LLM pass and return the narrative markdown. */
export async function narrate(a: Analysis, client: LlmClient): Promise<string> {
  const text = (await client.complete(buildMessages(a))).trim();
  if (!text) throw new Error("LLM returned an empty narrative");
  const header = `<!-- generated by sbperf narrate (${client.model}) from analysis.json; the deterministic report.html is ground truth -->\n\n`;
  return header + text + "\n";
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
