/**
 * Pure server-log freeze-warning parser. Extracts freeze-warning entries from
 * Postgres server logs (triggered when age(datfrozenxid) crosses the Postgres
 * warning threshold). Returns null if the log contains no freeze evidence.
 *
 * Postgres logs freeze warnings like:
 *   WARNING: database "postgres" must be vacuumed within 123456 transactions
 *
 * This is a parallel to locklog.ts (lockWaveSummary) - a read-only, pure parser
 * for retrospective analysis from the logs.
 */

export interface FreezeSummary {
  mustVacuumWithin: number | null;
  oldestXminWarnings: number;
  antiWraparoundVacuums: number;
  relations: string[];
  samples: string[];
}

/**
 * Parse freeze warnings and anti-wraparound vacuum evidence from raw server log
 * text. Returns null if no freeze evidence is found.
 */
export function parseFreezeLog(text: string): FreezeSummary | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const lines = text.split("\n");
  let mustVacuumWithin: number | null = null;
  let oldestXminWarnings = 0;
  let antiWraparoundVacuums = 0;
  const relations = new Set<string>();
  const samples: string[] = [];
  const maxSamples = 10;
  // Measured: a single forced-autovacuum pass over a real cluster logged 320
  // anti-wraparound lines naming ~160 distinct relations. Unbounded, that set
  // lands verbatim in analysis.json and the report, so cap it - the point is
  // "which tables, roughly", not a complete inventory.
  const maxRelations = 20;

  // Pattern 1: "must be vacuumed within N transactions" - the worst is the smallest N.
  const mustVacuumPattern =
    /WARNING:\s+database\s+"[^"]+"\s+must\s+be\s+vacuumed\s+within\s+(\d+)\s+transactions/;
  // Pattern 2: "oldest xmin is far in the past" - a count of occurrences.
  const oldestXminPattern = /WARNING:\s+oldest\s+xmin\s+is\s+far\s+in\s+the\s+past/;
  // Pattern 3: "automatic aggressive vacuum to prevent wraparound of table" - extract relation name.
  const antiVacuumPattern =
    /LOG:\s+automatic\s+aggressive\s+vacuum\s+to\s+prevent\s+wraparound\s+of\s+table\s+"([^"]+)"/;

  for (const line of lines) {
    const mustMatch = line.match(mustVacuumPattern);
    if (mustMatch) {
      const val = Number(mustMatch[1]) || 0;
      if (mustVacuumWithin === null || val < mustVacuumWithin) {
        mustVacuumWithin = val;
      }
      if (samples.length < maxSamples) {
        samples.push(line);
      }
    }

    if (line.match(oldestXminPattern)) {
      oldestXminWarnings++;
      if (samples.length < maxSamples) {
        samples.push(line);
      }
    }

    const antiMatch = line.match(antiVacuumPattern);
    if (antiMatch) {
      antiWraparoundVacuums++;
      if (relations.size < maxRelations) relations.add(antiMatch[1]!);
      if (samples.length < maxSamples) {
        samples.push(line);
      }
    }
  }

  const hasEvidence =
    mustVacuumWithin !== null || oldestXminWarnings > 0 || antiWraparoundVacuums > 0;
  if (!hasEvidence) {
    return null;
  }

  return {
    mustVacuumWithin,
    oldestXminWarnings,
    antiWraparoundVacuums,
    relations: Array.from(relations),
    samples,
  };
}
