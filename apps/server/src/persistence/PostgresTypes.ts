import * as PgTypes from "@effect/sql-pg/PgTypes";
import * as Result from "effect/Result";

export function makeRegistry(): PgTypes.Registry {
  const registry = PgTypes.makeRegistry();
  for (const oid of [PgTypes.OID.int8, PgTypes.OID.numeric]) {
    registry.register(oid, {
      encode: (value) => PgTypes.encode(value, oid),
      decode: (bytes) =>
        Result.flatMap(PgTypes.decode(bytes, oid, 1), (value) => {
          const number = Number(value);
          return Number.isFinite(number) &&
            (!Number.isInteger(number) || Number.isSafeInteger(number))
            ? Result.succeed(number)
            : Result.fail(
                new PgTypes.CodecError({
                  message: "Database number exceeds the client numeric range",
                }),
              );
        }),
    });
  }
  registry.register(PgTypes.OID.bool, {
    encode: (value) =>
      PgTypes.encode(typeof value === "number" ? value !== 0 : value, PgTypes.OID.bool),
    decode: (bytes) =>
      Result.map(PgTypes.decode(bytes, PgTypes.OID.bool, 1), (value) => (value === true ? 1 : 0)),
  });
  return registry;
}
