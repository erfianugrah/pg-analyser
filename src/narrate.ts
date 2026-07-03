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

const SYSTEM_PROMPT = `You are a senior Supabase/Postgres performance engineer writing the narrative for a database audit report. You are given a JSON object with the project's facts: ranked findings (each with catalogued remediation guidance and a doc URL), confirmed-healthy observations, and a bounded evidence digest of raw diagnostics.

Rules:
- Ground every statement in the supplied JSON. Do NOT invent numbers, thresholds, table names, or facts that are not present. If something is unknown, say so.
- Specifically, do NOT state a concrete downtime duration, timeout value, pool percentage, or auth-method name (TOTP/SMS/WebAuthn) unless it appears in the JSON. Either omit it or mark it explicitly as an example ("e.g. ...").
- Use the provided remediation text and doc URLs; cite the doc URL inline when you give a fix. Never fabricate a URL.
- If "degraded" is true or there are collectionNotes, state up front that diagnostics were incomplete and that absence of a finding is not proof of health.
- Be concise and utilitarian: plain language, no marketing tone, no filler. Prefer specifics (the actual query/table/percent) over generalities.
- Prioritise by severity (high first). Explain the likely root cause and the concrete fix for each finding, referencing the evidence.

Output GitHub-flavoured Markdown with these sections:
1. "## Executive summary" - 2-4 sentences: overall posture + the single most important action.
2. "## Priorities" - a numbered list of the top actions in order, each one line.
3. "## Findings" - one "### <severity> - <title>" subsection per finding: root cause, evidence, fix (with doc link).
4. "## What's healthy" - short bullets from the positives (omit if none).
5. "## Caveats" - collection gaps / staleness from sync + collectionNotes (omit if none).`;

export function buildMessages(a: Analysis): LlmMessage[] {
  const input = buildNarrativeInput(a);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Write the narrative for this project audit.\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
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
