import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as PostgresTest from "./testkit/Postgres.ts";
import * as Sqlite from "./Sqlite.ts";
import * as Postgres from "./Postgres.ts";
import * as SqliteToPostgres from "./SqliteToPostgres.ts";

const platform = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer);
const testLayer = PostgresTest.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "postgres-import-" })),
  Layer.provideMerge(platform),
);
const seed = (badNumber: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, auto_pull)
    VALUES ('fixture', '中文迁移项目', '/fixture', '[]', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z', ${badNumber ? "broken" : 0})`;
    yield* sql`INSERT INTO orchestration_events (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES (41, 'source-event', 'thread', 'source-thread', 0, 'provider-session.detached', '2026-11-23T00:00:00.000Z', 'server', '{"providerSessionId":"session","detachedAt":"2026-11-23T00:00:00.000Z"}', '{}', 2)`;
    // Pruned events still reserve their cursor range even though MAX(sequence) is lower.
    yield* sql`UPDATE sqlite_sequence SET seq = 100 WHERE name = 'orchestration_events'`;
  });

const configuredImport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const url = yield* Config.String("STARDUST_TEST_POSTGRES_URL");
  const schema = (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema;
  yield* fs.writeFileString(config.environmentIdPath, "storage-test\n");
  const provider = ConfigProvider.fromEnv({
    env: {
      T3CODE_DATABASE_BACKEND: "postgres",
      T3CODE_DATABASE_URL: url,
      T3CODE_POSTGRES_SCHEMA: schema,
    },
  });
  return {
    config,
    fs,
    schema,
    url,
    run: SqliteToPostgres.migrate().pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
    ),
  };
});

it.live(
  "verifies every imported table, advances sequences, preserves the source and restores the rollback snapshot",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { config, fs, schema, url, run } = yield* configuredImport;
      yield* seed(false).pipe(Effect.provide(Sqlite.layerFromPath(config.dbPath)));
      const before = yield* fs.readFile(config.dbPath);
      const report = yield* run;
      assert.lengthOf(report.tables, 48);
      assert.equal(report.tables.find((table) => table.table === "orchestration_events")?.rows, 1);
      assert.deepEqual(yield* fs.readFile(config.dbPath), before);
      assert.match(yield* fs.readFileString(report.reportPath), /"backupSha256":"[0-9a-f]{64}"/);
      assert.deepEqual(yield* sql`SELECT title FROM projection_projects`, [
        { title: "中文迁移项目" },
      ]);
      const added = yield* sql<{
        sequence: number;
      }>`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      SELECT 'after-import', aggregate_kind, stream_id, 1, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version FROM orchestration_events WHERE sequence = 41 RETURNING sequence`;
      assert.equal(added[0]?.sequence, 101);
      const restartRows = yield* Effect.gen(function* () {
        const database = yield* SqlClient.SqlClient;
        return yield* database`SELECT 1 FROM stardust_storage_metadata WHERE status = 'ready' AND source_sha256 IS NOT NULL`;
      }).pipe(
        Effect.provide(
          Postgres.layer({
            url: Redacted.make(url),
            schema,
            poolSize: 2,
            environmentId: "storage-test",
            allowInitialize: false,
          }),
        ),
      );
      assert.lengthOf(restartRows, 1);
      const repeated = yield* run.pipe(Effect.flip);
      assert.equal(repeated._tag, "DatabaseImportError");
      const restored = `${config.dbPath}.restored`;
      yield* fs.copyFile(report.backupPath, restored);
      yield* Effect.gen(function* () {
        const backup = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* backup`SELECT title FROM projection_projects`, [
          { title: "中文迁移项目" },
        ]);
        assert.deepEqual(
          yield* backup`SELECT MAX(sequence) AS sequence FROM orchestration_events`,
          [{ sequence: 41 }],
        );
        assert.deepEqual(yield* backup`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      }).pipe(Effect.provide(Sqlite.layerFromPath(restored)));
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "rolls back a failed import, keeps its backup and permits a repaired retry into the empty target",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { config, fs, run } = yield* configuredImport;
      yield* seed(true).pipe(Effect.provide(Sqlite.layerFromPath(config.dbPath)));
      const failure = yield* run.pipe(Effect.flip);
      assert.equal(failure._tag, "SqlError");
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`, [
        { count: 0 },
      ]);
      assert.isTrue(
        (yield* fs.readDirectory(config.stateDir)).some((name) =>
          /^statev2-before-postgres-.*\.sqlite$/.test(name),
        ),
      );
      yield* Effect.gen(function* () {
        const source = yield* SqlClient.SqlClient;
        yield* source`UPDATE projection_projects SET auto_pull = 0`;
      }).pipe(Effect.provide(Sqlite.layerFromPath(config.dbPath)));
      const report = yield* run;
      assert.lengthOf(report.tables, 48);
      assert.deepEqual(yield* sql`SELECT title FROM projection_projects`, [
        { title: "中文迁移项目" },
      ]);
    }).pipe(Effect.provide(testLayer)),
);
