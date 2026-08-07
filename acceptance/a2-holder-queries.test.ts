// Acceptance - plan Task 2: the four xmin-horizon holder planes.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { QUERIES } from "../src/sql.ts";
import { analysis } from "./fixture.ts";

const Q = QUERIES as unknown as Record<string, string>;

describe("Task 2 - replication slots expose the horizon they hold", () => {
  test("slot query selects wal_status, xmin and catalog_xmin", () => {
    const q = QUERIES.replicationSlots.toLowerCase();
    expect(q).toContain("wal_status");
    expect(q).toContain("catalog_xmin");
    expect(q).toContain("xmin_age");
  });

  test("slot query keeps retained_wal_bytes (consumed by the store scalar)", () => {
    expect(QUERIES.replicationSlots.toLowerCase()).toContain("retained_wal_bytes");
  });
});

describe("Task 2 - the other three holder classes", () => {
  test("preparedXacts reads pg_prepared_xacts with an age", () => {
    expect(Q.preparedXacts).toBeDefined();
    const q = String(Q.preparedXacts).toLowerCase();
    expect(q).toContain("pg_prepared_xacts");
    expect(q).toContain("age(");
    expect(q).toContain("gid");
  });

  test("xminHolders reads pg_stat_activity backend_xmin / backend_xid", () => {
    expect(Q.xminHolders).toBeDefined();
    const q = String(Q.xminHolders).toLowerCase();
    expect(q).toContain("pg_stat_activity");
    expect(q).toContain("backend_xmin");
    expect(q).toContain("backend_xid");
  });

  test("xminHolders is NOT narrowed to active client backends (idle-in-txn must show)", () => {
    const q = String(Q.xminHolders).toLowerCase();
    expect(q).not.toContain("state <> 'idle'");
    expect(q).not.toContain("backend_type = 'client backend'");
  });

  test("replicationXmin reads pg_stat_replication backend_xmin", () => {
    expect(Q.replicationXmin).toBeDefined();
    const q = String(Q.replicationXmin).toLowerCase();
    expect(q).toContain("pg_stat_replication");
    expect(q).toContain("backend_xmin");
  });
});

describe("Task 2 - the planes reach the analysis schema with back-compat defaults", () => {
  test("preparedXacts / xminHolders / replicationXmin survive a schema parse", () => {
    const a = analysis((raw) => {
      raw.sql.preparedXacts = [{ gid: "g1", xid_age: 1 }];
      raw.sql.xminHolders = [{ pid: 1, xmin_age: 1 }];
      raw.sql.replicationXmin = [{ application_name: "r", xmin_age: 1 }];
    });
    const sql = a.sql as unknown as Record<string, unknown[]>;
    expect(sql.preparedXacts).toHaveLength(1);
    expect(sql.xminHolders).toHaveLength(1);
    expect(sql.replicationXmin).toHaveLength(1);
  });

  test("an analysis written before these planes existed still parses", () => {
    const a = analysis();
    const sql = a.sql as unknown as Record<string, unknown[]>;
    expect(sql.preparedXacts).toEqual([]);
    expect(sql.xminHolders).toEqual([]);
    expect(sql.replicationXmin).toEqual([]);
  });
});
