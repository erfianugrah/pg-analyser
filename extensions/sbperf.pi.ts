/**
 * sbperf pi extension - drive the sbperf CLI from pi as a single tool.
 *
 * Sync to your env:
 *   ln -s ~/sbperf/extensions/sbperf.pi.ts ~/.pi/agent/extensions/sbperf.pi.ts
 *   # (or copy it). Restart pi. The `sbperf` tool then appears.
 *
 * Binary resolution (first that works):
 *   1. $SBPERF_BIN                       (explicit path to the compiled binary)
 *   2. `sbperf` on $PATH                 (after `bun run build && mv sbperf ~/.local/bin`)
 *   3. `bun run $SBPERF_REPO/src/index.ts`  ($SBPERF_REPO or ~/sbperf)
 *
 * The interesting bit is the copy-paste narrate round-trip WITHOUT any LLM
 * endpoint: pi itself is the model.
 *   - action "narrate_prompt" runs `narrate <dir> --print-prompt` and RETURNS the
 *     grounded prompt (system rules + JSON digest) as the tool result, so pi can
 *     write the executive summary in-session, grounded in the collected facts.
 *   - action "narrate_import" takes that written summary back and embeds it via
 *     `narrate <dir> --import -`, then you render with report(narrative:true).
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const pexec = promisify(execFile);

const REPO = process.env.SBPERF_REPO ?? join(homedir(), "sbperf");

/** Run a command, feeding optional stdin, capturing output (no throw on exit>0). */
function spawn(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ENOENT (binary not found) rejects so we can fall back; a non-zero exit
      // with output resolves (the CLI prints its error to stderr).
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

/** Invoke sbperf: explicit $SBPERF_BIN, else `sbperf` on PATH, else bun+source. */
async function run(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  if (process.env.SBPERF_BIN) return spawn(process.env.SBPERF_BIN, args, stdin);
  try {
    return await spawn("sbperf", args, stdin);
  } catch {
    return spawn("bun", ["run", join(REPO, "src/index.ts"), ...args], stdin);
  }
}

const sbperfTool = defineTool({
  name: "sbperf",
  label: "sbperf",
  description:
    "Run the sbperf Supabase performance auditor. Actions: analyze/full (collect + render a project), report/pdf/summary (re-render a dir), narrate_prompt (get the grounded executive-summary prompt so YOU can write it in-session), narrate_import (embed a summary you wrote back). Then report with narrative=true.",
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("analyze"),
        Type.Literal("full"),
        Type.Literal("report"),
        Type.Literal("pdf"),
        Type.Literal("summary"),
        Type.Literal("narrate_prompt"),
        Type.Literal("narrate_import"),
      ],
      { description: "What to do" },
    ),
    ref: Type.Optional(Type.String({ description: "Project ref (analyze/full)" })),
    dir: Type.Optional(
      Type.String({ description: "Report dir with analysis.json (report/pdf/summary/narrate_*)" }),
    ),
    out: Type.Optional(Type.String({ description: "Output dir override (analyze/full)" })),
    narrative: Type.Optional(
      Type.Boolean({ description: "report/pdf: embed the narrative (run narrate_import first)" }),
    ),
    summary: Type.Optional(
      Type.String({ description: "narrate_import: the executive-summary markdown to embed" }),
    ),
  }),

  async execute(_id, p) {
    const a = p.action;
    if ((a === "analyze" || a === "full") && !p.ref)
      return { content: [{ type: "text", text: "error: ref is required for analyze/full" }] };
    if ((a === "report" || a === "pdf" || a === "summary" || a.startsWith("narrate")) && !p.dir)
      return { content: [{ type: "text", text: `error: dir is required for ${a}` }] };

    try {
      if (a === "analyze" || a === "full") {
        const args = [a, "--ref", p.ref!, ...(p.out ? ["--out", p.out] : [])];
        const { stderr } = await run(args);
        const dirMatch = stderr.match(/done: (\S+)|> (reports\/\S+)/);
        return {
          content: [{ type: "text", text: stderr.trim() || "done" }],
          details: { dir: dirMatch?.[1] ?? dirMatch?.[2] },
        };
      }
      if (a === "report" || a === "pdf" || a === "summary") {
        const args = [a, p.dir!, ...(p.narrative && a !== "summary" ? ["--narrative"] : [])];
        const { stderr } = await run(args);
        return { content: [{ type: "text", text: stderr.trim() || "done" }] };
      }
      if (a === "narrate_prompt") {
        await run(["narrate", p.dir!, "--print-prompt"]);
        const prompt = await Bun.file(join(p.dir!, "prompt.md")).text();
        return {
          content: [
            {
              type: "text",
              text:
                "Grounded executive-summary prompt below. Write the summary per its rules, " +
                "then call sbperf(action:'narrate_import', dir, summary:<your markdown>).\n\n" +
                prompt,
            },
          ],
        };
      }
      // narrate_import
      if (!p.summary?.trim())
        return { content: [{ type: "text", text: "error: summary markdown is required" }] };
      const { stderr } = await run(["narrate", p.dir!, "--import", "-"], p.summary);
      return {
        content: [
          {
            type: "text",
            text: `${stderr.trim()}\n> render: sbperf(action:'report', dir, narrative:true)`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `sbperf failed: ${err instanceof Error ? err.message : err}` },
        ],
      };
    }
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(sbperfTool);
}
