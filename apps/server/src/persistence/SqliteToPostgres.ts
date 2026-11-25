// @effect-diagnostics nodeBuiltinImport:off -- Offline snapshot/import uses Node's SQLite backup and streaming hash APIs.
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as Sqlite from "./Sqlite.ts";
import * as Postgres from "./Postgres.ts";
import * as StorageConfig from "./StorageConfig.ts";
import { POSTGRES_TABLE_NAMES } from "./postgres/baseline.ts";

export class DatabaseImportError extends Schema.TaggedError<DatabaseImportError>()(
  "DatabaseImportError",
  {
    stage: Schema.Literals([
      "configuration",
      "snapshot",
      "integrity",
      "target-not-empty",
      "copy",
      "verify",
    ]),
    table: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `SQLite to PostgreSQL migration failed at ${this.stage}${this.table ? ` (${this.table})` : ""}. The source and verified backup are retained.`;
  }
}

const openSource = Effect.fn("SqliteToPostgres.openSource")((path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(path, { readOnly: true }),
      catch: (cause) => new DatabaseImportError({ stage: "snapshot", cause }),
    }),
    (database) => Effect.sync(() => database.close()),
  ),
);

const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const checkIntegrity = Effect.fn("SqliteToPostgres.checkIntegrity")(function* (path: string) {
  const database = yield* openSource(path);
  yield* Effect.try({
    try: () => {
      const integrity = database.prepare("PRAGMA integrity_check").all();
      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
      if (
        integrity.length !== 1 ||
        integrity[0]?.integrity_check !== "ok" ||
        foreignKeys.length !== 0
      )
        throw new Error("Snapshot integrity check failed");
    },
    catch: (cause) => new DatabaseImportError({ stage: "integrity", cause }),
  });
}, Effect.scoped);

const fileDigest = Effect.fn("SqliteToPostgres.fileDigest")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const digest = NodeCrypto.createHash("sha256");
  yield* Stream.runForEach(fs.stream(file), (chunk) =>
    Effect.sync(() => {
      digest.update(chunk);
    }),
  );
  return digest.digest("hex");
});

const hashRow = (
  hash: NodeCrypto.Hash,
  columns: readonly string[],
  row: Readonly<Record<string, unknown>>,
) => {
  const encoded = JSON.stringify(columns.map((column) => row[column] ?? null));
  hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
};
const rowBytes = (row: Readonly<Record<string, unknown>>) => Buffer.byteLength(JSON.stringify(row));

const copyAndVerify = Effect.fn("SqliteToPostgres.copyAndVerify")(
  function* (sourcePath: string, sourceDigest: string) {
    const sql = yield* SqlClient.SqlClient;
    const source = yield* openSource(sourcePath);
    const result: Array<{ table: string; rows: number; sha256: string }> = [];
    const metadata = yield* sql<{
      imported_at: string | null;
    }>`SELECT imported_at FROM stardust_storage_metadata WHERE singleton = 1`;
    if (metadata[0]?.imported_at !== null)
      return yield* new DatabaseImportError({ stage: "target-not-empty" });
    for (const table of POSTGRES_TABLE_NAMES) {
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`;
      if (rows[0]?.count !== 0)
        return yield* new DatabaseImportError({ stage: "target-not-empty", table });
    }
    for (const table of POSTGRES_TABLE_NAMES)
      yield* sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
    for (const table of POSTGRES_TABLE_NAMES) {
      const definition = yield* Effect.try({
        try: () => {
          const stored = source
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table);
          if (!stored) throw new Error("Source schema is missing a table");
          const fields = source.prepare(`PRAGMA table_info("${table}")`).all();
          const columns = fields.map((field) => String(field.name));
          const rowid =
            !String(stored.sql).includes("WITHOUT ROWID") && !columns.includes("sequence");
          if (rowid) columns.push("rowid");
          const primary = fields
            .filter((field) => Number(field.pk) > 0)
            .toSorted((a, b) => Number(a.pk) - Number(b.pk))
            .map((field) => `"${field.name}"`);
          return { columns, order: rowid ? "rowid" : primary.join(","), rowid };
        },
        catch: (cause) => new DatabaseImportError({ stage: "copy", table, cause }),
      });
      const sourceHash = NodeCrypto.createHash("sha256");
      const select = definition.columns.map((column) => `"${column}"`).join(",");
      const iterator = source
        .prepare(`SELECT ${select} FROM "${table}" ORDER BY ${definition.order}`)
        .iterate();
      let count = 0;
      let done = false;
      for (;;) {
        const batch = yield* Effect.try({
          try: () => {
            const rows: Array<Record<string, NodeSqlite.SQLOutputValue>> = [];
            let bytes = 0;
            while (rows.length < 64 && bytes < 2 * 1024 * 1024) {
              const next = iterator.next();
              if (next.done) {
                done = true;
                break;
              }
              hashRow(sourceHash, definition.columns, next.value);
              bytes += rowBytes(next.value);
              rows.push(next.value);
            }
            return rows;
          },
          catch: (cause) => new DatabaseImportError({ stage: "copy", table, cause }),
        });
        const first = batch[0];
        if (first === undefined) break;
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert([first, ...batch.slice(1)])}`;
        count += batch.length;
        if (done) break;
      }
      const targetHash = NodeCrypto.createHash("sha256");
      const cursorColumn = definition.columns.includes("sequence") ? "sequence" : "rowid";
      let cursor: number | undefined;
      let verified = 0;
      for (;;) {
        const rows = yield* sql<Record<string, unknown>>`
        SELECT ${sql.literal(select)}, ${sql(cursorColumn)} AS __cursor FROM ${sql(table)}
        ${cursor === undefined ? sql`` : sql`WHERE ${sql(cursorColumn)} > ${cursor}`} ORDER BY ${sql(cursorColumn)} LIMIT 128
      `;
        for (const row of rows) hashRow(targetHash, definition.columns, row);
        verified += rows.length;
        if (rows.length < 128) break;
        cursor = Number(rows.at(-1)?.__cursor);
      }
      const sha256 = sourceHash.digest("hex");
      if (verified !== count || targetHash.digest("hex") !== sha256)
        return yield* new DatabaseImportError({ stage: "verify", table });
      result.push({ table, rows: count, sha256 });
      // Imported IDs must not collide with later inserts, including explicit SQLite rowids.
      const sequenceColumn = definition.columns.includes("sequence") ? "sequence" : "rowid";
      const sequence = table === "orchestration_events" ? "application_event_sequence" : undefined;
      const highWater = definition.columns.includes("sequence")
        ? yield* Effect.try({
            try: () =>
              Number(
                source.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ??
                  0,
              ),
            catch: (cause) => new DatabaseImportError({ stage: "verify", table, cause }),
          })
        : 0;
      yield* sql`SELECT setval(
      CAST(COALESCE(${sequence ?? null}, pg_get_serial_sequence(${table}, ${sequenceColumn})) AS regclass),
      GREATEST(COALESCE((SELECT MAX(${sql(sequenceColumn)}) FROM ${sql(table)}), 0), ${highWater}, 1),
      GREATEST(COALESCE((SELECT MAX(${sql(sequenceColumn)}) FROM ${sql(table)}), 0), ${highWater}) > 0
    )`;
    }
    for (const table of POSTGRES_TABLE_NAMES)
      yield* sql.unsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE stardust_storage_metadata SET imported_at = ${now}, source_sha256 = ${sourceDigest}, status = 'ready' WHERE singleton = 1`;
    return result;
  },
  (effect) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(effect);
    }),
  Effect.scoped,
);

export const migrate = Effect.fn("SqliteToPostgres.migrate")(
  function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const storage = yield* StorageConfig.make();
    if (
      storage.backend !== "postgres" ||
      !storage.postgresUrl ||
      !(yield* fs.exists(config.dbPath))
    )
      return yield* new DatabaseImportError({ stage: "configuration" });
    yield* ServerOwnership.holdServerOwnershipLock(config.serverRuntimeStatePath);
    const guard = yield* Postgres.holdOwnership({
      url: storage.postgresUrl,
      schema: storage.schema,
    });
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    const id = yield* random.uuidV4();
    const backupPath = path.join(
      path.dirname(config.dbPath),
      `statev2-before-postgres-${id}.sqlite`,
    );
    const stagingPath = `${backupPath}.staging`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const source = yield* openSource(config.dbPath);
        yield* Effect.tryPromise({
          try: () => NodeSqlite.backup(source, `${backupPath}.partial`),
          catch: (cause) => new DatabaseImportError({ stage: "snapshot", cause }),
        });
      }),
    );
    yield* fs.chmod(`${backupPath}.partial`, 0o600);
    yield* fs.rename(`${backupPath}.partial`, backupPath);
    yield* checkIntegrity(backupPath);
    const backupSha256 = yield* fileDigest(backupPath);
    yield* fs.copyFile(backupPath, stagingPath);
    yield* Effect.provide(Effect.void, Sqlite.layerFromPath(stagingPath));
    yield* checkIntegrity(stagingPath);
    const imported = copyAndVerify(stagingPath, backupSha256).pipe(
      Effect.provide(
        Postgres.layer({
          url: storage.postgresUrl,
          schema: storage.schema,
          poolSize: storage.poolSize,
          environmentId,
          allowInitialize: true,
          initializeForImport: true,
        }),
      ),
    );
    const tables = yield* Effect.raceFirst(imported, guard);
    const report = { environmentId, schema: storage.schema, backupPath, backupSha256, tables };
    const reportPath = `${backupPath}.manifest.json`;
    const encoded = yield* encodeReport(report);
    yield* fs.writeFileString(reportPath, encoded);
    yield* fs.chmod(reportPath, 0o600);
    return { ...report, reportPath };
  },
  Effect.scoped,
  (effect) => effect.pipe(Effect.provide(ServerEnvironment.layerIdentity)),
);
