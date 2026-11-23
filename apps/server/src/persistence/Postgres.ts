import * as PgClient from "@effect/sql-pg/PgClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Reactivity from "effect/reactivity/Reactivity";

import { makeRegistry } from "./PostgresTypes.ts";
import {
  POSTGRES_INDEX_STATEMENTS,
  POSTGRES_TABLE_STATEMENTS,
  POSTGRES_TRIGGER_STATEMENTS,
  SOURCE_SQLITE_MIGRATION,
} from "./postgres/baseline.ts";
import { POSTGRES_FUNCTION_STATEMENTS } from "./postgres/functions.ts";
import { POSTGRES_SEARCH_STATEMENTS } from "./postgres/search.ts";
import { BUILD_MIGRATION_HEAD } from "./databaseMigrationHead.ts";

export class PostgresSchemaError extends Schema.TaggedError<PostgresSchemaError>()(
  "PostgresSchemaError",
  {
    reason: Schema.Literals([
      "unsafe-schema",
      "unrecognized-schema",
      "newer-schema",
      "environment-mismatch",
      "migration-required",
    ]),
  },
) {
  override get message(): string {
    return `PostgreSQL storage refused to start (${this.reason}). Check the schema and environment identity; migrate an existing SQLite database before switching backends.`;
  }
}

export interface PostgresOptions {
  readonly url: Redacted.Redacted<string>;
  readonly schema: string;
  readonly poolSize: number;
  readonly environmentId: string;
  readonly allowInitialize: boolean;
  readonly initializeForImport?: boolean;
}

export const migrate = Effect.fn("Postgres.migrate")(function* (options: PostgresOptions) {
  if (BUILD_MIGRATION_HEAD !== SOURCE_SQLITE_MIGRATION)
    return yield* new PostgresSchemaError({ reason: "newer-schema" });
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
    return yield* new PostgresSchemaError({ reason: "unsafe-schema" });
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${options.schema}), 0)`;
      yield* sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${options.schema}"`);
      const tables = yield* sql<{ name: string }>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = ${options.schema}
    `;
      if (tables.some((table) => table.name === "stardust_storage_metadata")) {
        const metadata = yield* sql<{
          version: number;
          environment_id: string;
          sqlite_migration: number;
          status: string;
          source_sha256: string | null;
        }>`
        SELECT version, environment_id, sqlite_migration, status, source_sha256 FROM stardust_storage_metadata WHERE singleton = 1
      `;
        if (metadata[0]?.version !== 1 || metadata[0].sqlite_migration !== SOURCE_SQLITE_MIGRATION)
          return yield* new PostgresSchemaError({ reason: "newer-schema" });
        if (metadata[0].environment_id !== options.environmentId)
          return yield* new PostgresSchemaError({ reason: "environment-mismatch" });
        if (
          !options.initializeForImport &&
          (metadata[0].status !== "ready" ||
            (!options.allowInitialize && metadata[0].source_sha256 === null))
        )
          return yield* new PostgresSchemaError({ reason: "migration-required" });
        return;
      }
      if (tables.length !== 0)
        return yield* new PostgresSchemaError({ reason: "unrecognized-schema" });
      if (!options.allowInitialize)
        return yield* new PostgresSchemaError({ reason: "migration-required" });
      for (const statement of POSTGRES_FUNCTION_STATEMENTS) yield* sql.unsafe(statement);
      for (const statement of POSTGRES_TABLE_STATEMENTS) yield* sql.unsafe(statement);
      for (const statement of POSTGRES_INDEX_STATEMENTS) yield* sql.unsafe(statement);
      for (const statement of POSTGRES_TRIGGER_STATEMENTS) yield* sql.unsafe(statement);
      for (const statement of POSTGRES_SEARCH_STATEMENTS) yield* sql.unsafe(statement);
      yield* sql`CREATE TABLE stardust_storage_metadata (
      singleton integer PRIMARY KEY CHECK (singleton = 1),
      version integer NOT NULL,
      sqlite_migration integer NOT NULL,
      environment_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('ready', 'awaiting-import')),
      imported_at text,
      source_sha256 text
    )`;
      yield* sql`INSERT INTO stardust_storage_metadata (singleton, version, sqlite_migration, environment_id, status)
      VALUES (1, 1, ${SOURCE_SQLITE_MIGRATION}, ${options.environmentId}, ${options.initializeForImport ? "awaiting-import" : "ready"})`;
    }),
  );
});

const make = Effect.fn("Postgres.make")(function* (options: PostgresOptions) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
    return yield* new PostgresSchemaError({ reason: "unsafe-schema" });
  const client = yield* PgClient.make({
    url: options.url,
    minConnections: 0,
    maxConnections: options.poolSize,
    connectTimeout: "5 seconds",
    applicationName: "stardust-server",
    maxMessageSize: 64 * 1024 * 1024,
    startupOptions: "",
    startupParameters: {
      search_path: `"${options.schema}",pg_catalog`,
      timezone: "UTC",
      synchronous_commit: "on",
      statement_timeout: "30000",
      lock_timeout: "10000",
      idle_in_transaction_session_timeout: "30000",
    },
    types: makeRegistry(),
  });
  const withTransaction = client.withTransaction;
  // Match SQLite's single writer lane; acquire before receipt/version reads, not at INSERT time.
  const ordered = Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.withFiber((fiber) => {
        if (Context.get(fiber.context, NodeSqliteClient.ReadOnly) !== undefined)
          return withTransaction(effect).pipe(
            Effect.provideService(
              SqlClient.BeginTransaction,
              "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
            ),
          );
        return withTransaction(
          client`SELECT pg_advisory_xact_lock(hashtext(${options.schema}), 1)`.pipe(
            Effect.andThen(effect),
          ),
        );
      }),
  });
  // Bootstrap owns its own lock and does not depend on application tables/functions yet.
  yield* migrate(options).pipe(Effect.provideService(SqlClient.SqlClient, ordered));
  return ordered as SqlClient.SqlClient;
});

export const layer = (options: PostgresOptions) =>
  Layer.effect(SqlClient.SqlClient, make(options)).pipe(Layer.provide(Reactivity.layer));

export class PostgresOwnershipError extends Schema.TaggedError<PostgresOwnershipError>()(
  "PostgresOwnershipError",
  {
    reason: Schema.Literals(["already-running", "connection-lost"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "already-running"
      ? "Another server or migration owns this PostgreSQL environment."
      : "The PostgreSQL ownership connection was lost. The server is stopping its local runtimes.";
  }
}

/** A dedicated connection never reconnects; losing it must terminate this environment's runtimes. */
export const holdOwnership = Effect.fn("Postgres.holdOwnership")(function* (
  options: Pick<PostgresOptions, "url" | "schema">,
) {
  const owner = yield* PgClient.makeClient({
    url: options.url,
    connectTimeout: "5 seconds",
    applicationName: "stardust-environment-owner",
    types: makeRegistry(),
    startupParameters: { statement_timeout: "5000" },
  }).pipe(Effect.provide(Reactivity.layer));
  const acquired = yield* owner<{
    acquired: number;
  }>`SELECT pg_try_advisory_lock(hashtext(${options.schema}), 2) AS acquired`;
  if (acquired[0]?.acquired !== 1)
    return yield* new PostgresOwnershipError({ reason: "already-running" });
  return owner`SELECT 1`.pipe(
    Effect.timeout("5 seconds"),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.mapError((cause) => new PostgresOwnershipError({ reason: "connection-lost", cause })),
    Effect.andThen(Effect.never),
  );
});
