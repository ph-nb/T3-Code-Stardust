import { describe, expect, it } from "vite-plus/test";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import * as Result from "effect/Result";
import { makeRegistry } from "./PostgresTypes.ts";

describe("PostgreSQL persistence result types", () => {
  it("keeps the existing numeric and predicate row shape without rounding event cursors", () => {
    const registry = makeRegistry();
    for (const value of [0n, 42n, 9_007_199_254_740_991n]) {
      const encoded = Result.getOrThrow(PgTypes.encode(value, PgTypes.OID.int8));
      expect(Result.getOrThrow(PgTypes.decode(encoded, PgTypes.OID.int8, 1, registry))).toBe(
        Number(value),
      );
    }
    const overflow = Result.getOrThrow(PgTypes.encode(9_007_199_254_740_992n, PgTypes.OID.int8));
    expect(Result.isFailure(PgTypes.decode(overflow, PgTypes.OID.int8, 1, registry))).toBe(true);
    for (const value of [false, true]) {
      const encoded = Result.getOrThrow(PgTypes.encode(value, PgTypes.OID.bool));
      expect(Result.getOrThrow(PgTypes.decode(encoded, PgTypes.OID.bool, 1, registry))).toBe(
        value ? 1 : 0,
      );
    }
  });
});
