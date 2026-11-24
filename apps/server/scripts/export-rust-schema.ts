// @effect-diagnostics nodeBuiltinImport:off -- Deterministic build-time export for the native Rust runtime.
import * as NodeFSP from "node:fs/promises";
import {
  POSTGRES_TABLE_STATEMENTS,
  POSTGRES_INDEX_STATEMENTS,
  POSTGRES_TRIGGER_STATEMENTS,
  SOURCE_SQLITE_MIGRATION,
} from "../src/persistence/postgres/baseline.ts";
import { POSTGRES_FUNCTION_STATEMENTS } from "../src/persistence/postgres/functions.ts";
import { POSTGRES_SEARCH_STATEMENTS } from "../src/persistence/postgres/search.ts";

if (SOURCE_SQLITE_MIGRATION !== 105)
  throw new Error("Update the native runtime schema version before exporting");
const directory = new URL("../../../native/stardust/schema/", import.meta.url);
await NodeFSP.mkdir(directory, { recursive: true });
const encoded = [
  "-- Generated from the shipping PostgreSQL schema. Regenerate with apps/server/scripts/export-rust-schema.ts.",
  ...[
    ...POSTGRES_FUNCTION_STATEMENTS,
    ...POSTGRES_TABLE_STATEMENTS,
    ...POSTGRES_INDEX_STATEMENTS,
    ...POSTGRES_TRIGGER_STATEMENTS,
    ...POSTGRES_SEARCH_STATEMENTS,
  ].map((statement) => `${statement.trim().replace(/;$/, "")};`),
  `CREATE TABLE stardust_storage_metadata (
    singleton integer PRIMARY KEY CHECK (singleton = 1), version integer NOT NULL,
    sqlite_migration integer NOT NULL, environment_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('ready', 'awaiting-import')),
    imported_at text, source_sha256 text
  );`,
  "",
].join("\n\n");
const destination = new URL("postgres-105.sql", directory);
if (process.argv.includes("--check")) {
  if ((await NodeFSP.readFile(destination, "utf8")) !== encoded)
    throw new Error("Rust PostgreSQL schema is stale");
} else await NodeFSP.writeFile(destination, encoded);
