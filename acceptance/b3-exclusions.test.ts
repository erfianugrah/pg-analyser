// Acceptance - alert pack Task 3: the coverage invariant. The interesting
// output of this feature is not the YAML, it is the boundary - so every
// heuristic must be either alerted or excluded WITH a named reason, and the
// invariant has to be mechanical rather than a promise in a doc.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import {
  ALERT_SPECS,
  EXCLUSIONS,
  PLANE_EXCLUSIONS,
  unclassifiedHeuristics,
} from "../src/alerts.ts";
import { HEURISTICS } from "../src/heuristics.ts";

const CLAUSES = ["no-metric", "no-panel", "semantics", "not-an-alert"];

describe("every heuristic is classified", () => {
  test("nothing is unclassified", () => {
    expect(unclassifiedHeuristics()).toEqual([]);
  });

  test("an alerted heuristic is not ALSO excluded", () => {
    const alerted = new Set(ALERT_SPECS.map((s) => s.heuristicId));
    for (const id of Object.keys(EXCLUSIONS))
      expect(alerted.has(id), `${id} is both alerted and excluded`).toBe(false);
  });

  test("every exclusion names one of the four clauses and says why", () => {
    for (const [id, e] of Object.entries(EXCLUSIONS)) {
      expect(CLAUSES, `${id} has clause ${e.clause}`).toContain(e.clause);
      expect(e.why.length, `${id} has no reason`).toBeGreaterThan(15);
    }
  });

  test("plane-level exclusions cover whole planes with a stated reason", () => {
    for (const [plane, why] of Object.entries(PLANE_EXCLUSIONS))
      expect(why.length, `plane ${plane} has no reason`).toBeGreaterThan(15);
  });

  test("the look-alertable-but-are-not cases are excluded on purpose", () => {
    // Named in the plan: each would page on a healthy project.
    // connections_ceiling WAS the third: excluded because the endpoint served
    // no max_connections metric. Verified live 2026-08-18 that the endpoint now
    // exports the configured limit (max_connections_connection_count), so the
    // exclusion was promoted to a real rule (SupabaseConnectionCeiling).
    for (const id of ["cache_hit_low", "disk_fill_projection"]) {
      expect(EXCLUSIONS[id], `${id} must be explicitly excluded`).toBeDefined();
      expect(EXCLUSIONS[id]?.why.length).toBeGreaterThan(15);
    }
  });

  test("connections_ceiling is no longer excluded - the endpoint serves the limit", () => {
    expect(EXCLUSIONS.connections_ceiling).toBeUndefined();
    expect(ALERT_SPECS.some((s) => s.heuristicId === "connections_ceiling")).toBe(true);
  });

  test("an exclusion cannot name a heuristic that does not exist", () => {
    for (const id of Object.keys(EXCLUSIONS))
      expect(HEURISTICS[id], `EXCLUSIONS names unknown heuristic ${id}`).toBeDefined();
  });

  test("adding a heuristic without classifying it breaks the invariant", () => {
    // The invariant must be computed, not hardcoded: injecting an unknown id
    // has to surface. This asserts unclassifiedHeuristics() reads HEURISTICS at
    // call time rather than returning a frozen list.
    const id = "__acceptance_probe__";
    (HEURISTICS as Record<string, unknown>)[id] = {
      plainTitle: "probe",
      whyItMatters: "probe",
      remediation: "probe",
      howToVerify: "probe",
      docUrl: "https://example.com",
      plane: "Vacuum",
    };
    try {
      expect(unclassifiedHeuristics()).toContain(id);
    } finally {
      delete (HEURISTICS as Record<string, unknown>)[id];
    }
  });
});
