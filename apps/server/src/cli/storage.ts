import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/cli";
import * as ServerConfig from "../config.ts";
import * as SqliteToPostgres from "../persistence/SqliteToPostgres.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const migratePostgres = Command.make("migrate-postgres", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Offline SQLite to PostgreSQL migration with a verified rollback backup. Requires T3CODE_DATABASE_URL and a stopped server.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const report = yield* SqliteToPostgres.migrate().pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      yield* Console.log(
        `Migration verified: ${report.tables.length} tables, ${report.tables.reduce((count, table) => count + table.rows, 0)} rows.`,
      );
      yield* Console.log(`Rollback backup: ${report.backupPath}`);
      yield* Console.log(`Verification manifest: ${report.reportPath}`);
      yield* Console.log(
        "Start the server with the same PostgreSQL configuration and T3 home. Preserve this backup and the environment's files and secrets.",
      );
    }),
  ),
);

export const storageCommand = Command.make("storage").pipe(
  Command.withDescription("Manage server persistence."),
  Command.withSubcommands([migratePostgres]),
);
