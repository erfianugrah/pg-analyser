// Acceptance - plan Task 3: severity ranked on absolute transactions, not a
// percentage of an arbitrary 2e9 denominator.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { deriveFindings } from "../src/findings.ts";
import { analysis, CEILING } from "./fixture.ts";

function withFreezeAge(age: number) {
  return analysis((raw) => {
    raw.sql.txidWraparound = [
      {
        schema: "public",
        table: "public.events",
        xid_age: age,
        toast_age: null,
        remaining: CEILING - age,
        pct_wraparound: Math.round((100 * age) / 2_000_000_000),
      },
    ];
  });
}

const freeze = (a: ReturnType<typeof analysis>) =>
  deriveFindings(a).find((f) => f.heuristicId === "txid_wraparound");

describe("Task 3 - the blocked-freeze rung fires below the old 400M warn point", () => {
  test("250M consumed XIDs produces a finding (today: silence)", () => {
    const f = freeze(withFreezeAge(250_000_000));
    expect(f).toBeDefined();
  });

  test("the finding reports transactions remaining, not just a percentage", () => {
    const f = freeze(withFreezeAge(250_000_000));
    const text = `${f?.title ?? ""} ${f?.evidence ?? ""}`;
    expect(text.toLowerCase()).toContain("remaining");
  });

  test("120M consumed XIDs stays quiet (below the blocked-freeze threshold)", () => {
    expect(freeze(withFreezeAge(120_000_000))).toBeUndefined();
  });
});

describe("Task 3 - the Postgres escalation points drive severity", () => {
  test("inside the 40M-remaining warning window the finding is high", () => {
    const f = freeze(withFreezeAge(CEILING - 30_000_000));
    expect(f?.severity).toBe("high");
  });

  test("inside the 3M-remaining stop window the finding says writes are refused", () => {
    const f = freeze(withFreezeAge(CEILING - 2_000_000));
    expect(f?.severity).toBe("high");
    expect(`${f?.title ?? ""} ${f?.evidence ?? ""}`).toMatch(
      /refus|not accepting|stops? accepting|halt/i,
    );
  });
});

describe("Task 3 - the database-level age (catalogs included) is not ignored", () => {
  test("an aged datfrozenxid with no aged user table still produces the finding", () => {
    const a = analysis((raw) => {
      raw.sql.databaseFreezeAge = [
        {
          datname: "postgres",
          xid_age: 900_000_000,
          mxid_age: 0,
          remaining: CEILING - 900_000_000,
        },
      ];
    });
    expect(deriveFindings(a).some((f) => f.heuristicId === "txid_wraparound")).toBe(true);
  });
});

describe("Task 3 - back-compat: an old analysis with only pct still ranks", () => {
  test("a row with pct_wraparound but no remaining still produces a finding", () => {
    const a = analysis((raw) => {
      raw.sql.txidWraparound = [
        { schema: "public", table: "public.old", xid_age: 900_000_000, pct_wraparound: 45 },
      ];
    });
    expect(deriveFindings(a).some((f) => f.heuristicId === "txid_wraparound")).toBe(true);
  });
});
