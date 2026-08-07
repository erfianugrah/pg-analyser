// Acceptance - plan Task 9: the evidence reaches the report.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { render } from "../src/report/render.ts";
import { analysis, CEILING } from "./fixture.ts";

const AGE = 250_000_000;

function loaded() {
  return analysis((raw) => {
    raw.sql.txidWraparound = [
      {
        schema: "public",
        table: "public.events",
        xid_age: AGE,
        toast_age: AGE,
        remaining: CEILING - AGE,
        pct_wraparound: 12,
      },
    ];
    raw.sql.databaseFreezeAge = [
      { datname: "postgres", xid_age: AGE, mxid_age: 0, remaining: CEILING - AGE },
    ];
    raw.sql.replicationSlots = [
      {
        slot_name: "stuck_consumer",
        slot_type: "logical",
        active: true,
        wal_status: "lost",
        xmin_age: null,
        catalog_xmin_age: 300_000_000,
        retained_wal_bytes: 1024,
      },
    ];
    raw.sql.preparedXacts = [{ gid: "orphan_gid_1", database: "postgres", xid_age: 300_000_000 }];
    raw.sql.xminHolders = [{ pid: 98345, xmin_age: 300_000_000, xid_age: null }];
    raw.sql.replicationXmin = [{ application_name: "replica_1", xmin_age: 300_000_000 }];
  });
}

describe("Task 9 - the horizon-holder section exists", () => {
  const html = () => render(loaded());

  test("a drill section with id 'xmin' is rendered", () => {
    expect(html()).toContain('id="xmin"');
  });

  test("every holder class shows up in the report body", () => {
    const h = html();
    expect(h).toContain("stuck_consumer");
    expect(h).toContain("orphan_gid_1");
    expect(h).toContain("98345");
    expect(h).toContain("replica_1");
  });

  test("the section is omitted when there are no holders", () => {
    expect(render(analysis())).not.toContain('id="xmin"');
  });

  test("the overlay can hide it like any other drill section", () => {
    const hidden = render(loaded(), {
      overlay: { hide: new Set(["xmin"]), notes: {} },
    });
    expect(hidden).not.toContain('id="xmin"');
  });
});

describe("Task 9 - the freeze section reports headroom", () => {
  test("remaining transactions are rendered, not only a percentage", () => {
    expect(render(loaded()).toLowerCase()).toContain("remaining");
  });

  test("the slot section shows wal_status", () => {
    expect(render(loaded()).toLowerCase()).toContain("wal_status");
  });
});
