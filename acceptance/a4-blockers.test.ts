// Acceptance - plan Task 4: name the xmin holder that is blocking the freeze.
// Contract only. Do not edit to make the implementation pass.
//
// Privilege note (measured on PostgreSQL 18.4 with a pg_read_all_data-only
// role): pg_stat_activity exposes age(backend_xmin)/age(backend_xid) for other
// users' backends, but masks state/backend_type/query. These fixtures therefore
// carry a masked holder row - a finding that depends on `query` or `state`
// cannot work on the read-only tier.
import { describe, expect, test } from "bun:test";
import { deriveFindings } from "../src/findings.ts";
import { analysis, CEILING } from "./fixture.ts";

const OLD = 300_000_000;

function agedTable(raw: { sql: Record<string, unknown> }, age = 250_000_000) {
  raw.sql.txidWraparound = [
    {
      schema: "public",
      table: "public.events",
      xid_age: age,
      toast_age: null,
      remaining: CEILING - age,
      pct_wraparound: Math.round((1000 * age) / 2_000_000_000) / 10,
    },
  ];
}

const ids = (a: ReturnType<typeof analysis>) => deriveFindings(a).map((f) => f.heuristicId ?? "");
const find = (a: ReturnType<typeof analysis>, id: string) =>
  deriveFindings(a).find((f) => f.heuristicId === id);
const text = (f: { title?: string; evidence?: string } | undefined) =>
  `${f?.title ?? ""} ${f?.evidence ?? ""}`;

describe("Task 4 - each holder class produces an attributed finding", () => {
  test("a logical slot holding an ancient catalog_xmin", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.replicationSlots = [
        {
          slot_name: "stuck_consumer",
          slot_type: "logical",
          active: true,
          active_pid: 4242,
          wal_status: "reserved",
          xmin: null,
          catalog_xmin: "1234",
          xmin_age: null,
          catalog_xmin_age: OLD,
          retained_wal_bytes: 1024,
        },
      ];
    });
    const f = find(a, "xmin_horizon_blocked");
    expect(f).toBeDefined();
    expect(text(f)).toContain("stuck_consumer");
  });

  test("an orphaned prepared transaction", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.preparedXacts = [
        { gid: "orphan_gid_1", database: "postgres", owner: "postgres", xid_age: OLD },
      ];
    });
    expect(ids(a)).toContain("prepared_xact_old");
    expect(text(find(a, "prepared_xact_old"))).toContain("orphan_gid_1");
  });

  test("a backend holding an old xmin, with its identifying columns masked", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.xminHolders = [
        {
          pid: 98345,
          datname: "postgres",
          usename: "postgres",
          state: null,
          backend_type: null,
          xmin_age: OLD,
          xid_age: OLD,
          xact_age_s: 90000,
          query: "<insufficient privilege>",
        },
      ];
    });
    const f = find(a, "xmin_horizon_blocked");
    expect(f).toBeDefined();
    expect(text(f)).toContain("98345");
  });

  test("a standby pinning the primary's horizon via hot_standby_feedback", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.replicationXmin = [
        { application_name: "replica_1", state: "streaming", sync_state: "async", xmin_age: OLD },
      ];
    });
    const f = find(a, "xmin_horizon_blocked");
    expect(f).toBeDefined();
    expect(text(f)).toContain("replica_1");
  });

  test("a young holder does NOT trip the finding", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.xminHolders = [{ pid: 1, xmin_age: 1000, xid_age: null }];
    });
    expect(ids(a)).not.toContain("xmin_horizon_blocked");
  });

  test("a null age is not read as zero and is not a holder", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.replicationSlots = [
        {
          slot_name: "physical_1",
          slot_type: "physical",
          active: true,
          wal_status: "reserved",
          xmin: null,
          catalog_xmin: null,
          xmin_age: null,
          catalog_xmin_age: null,
          retained_wal_bytes: 0,
        },
      ];
    });
    expect(ids(a)).not.toContain("xmin_horizon_blocked");
  });
});

describe("Task 4 - a lost slot is its own finding, not a WAL-retention one", () => {
  const lost = () =>
    analysis((raw) => {
      raw.sql.replicationSlots = [
        {
          slot_name: "dead_slot",
          slot_type: "logical",
          active: false,
          wal_status: "lost",
          xmin: null,
          catalog_xmin: null,
          xmin_age: null,
          catalog_xmin_age: null,
          retained_wal_bytes: 5_000_000,
        },
      ];
    });

  test("wal_status = 'lost' produces replication_slot_lost", () => {
    expect(ids(lost())).toContain("replication_slot_lost");
    expect(text(find(lost(), "replication_slot_lost"))).toContain("dead_slot");
  });

  test("it is NOT also reported as an inactive slot retaining WAL", () => {
    // Measured on the unchanged tree: a lost slot produced exactly the
    // wal_retained_inactive_slot card - wrong, since a lost slot has already
    // stopped retaining WAL.
    expect(ids(lost())).not.toContain("wal_retained_inactive_slot");
  });

  test("an ordinary inactive slot still produces the WAL-retention finding", () => {
    const a = analysis((raw) => {
      raw.sql.replicationSlots = [
        {
          slot_name: "idle_slot",
          slot_type: "logical",
          active: false,
          wal_status: "reserved",
          retained_wal_bytes: 5_000_000,
        },
      ];
    });
    expect(ids(a)).toContain("wal_retained_inactive_slot");
  });
});

describe("Task 4 - no explicable holder at a blocked age escalates", () => {
  test("aged freeze with every holder plane empty signposts the corruption branch", () => {
    const a = analysis((raw) => agedTable(raw));
    const f = find(a, "freeze_blocked_no_holder");
    expect(f).toBeDefined();
    expect(text(f).toLowerCase()).toContain("amcheck");
  });

  test("it does NOT fire when a holder explains the age", () => {
    const a = analysis((raw) => {
      agedTable(raw);
      raw.sql.preparedXacts = [{ gid: "g", xid_age: OLD }];
    });
    expect(ids(a)).not.toContain("freeze_blocked_no_holder");
  });

  test("it does NOT fire on a young freeze age", () => {
    const a = analysis((raw) => agedTable(raw, 1_000_000));
    expect(ids(a)).not.toContain("freeze_blocked_no_holder");
  });
});
