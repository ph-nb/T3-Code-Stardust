import type * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

export const isPostgres = (sql: SqlClient.SqlClient): boolean =>
  sql.driver === "pg" || sql.driver === "pglite";

export const indexedBy = (sql: SqlClient.SqlClient, index: string): Fragment =>
  sql.literal(isPostgres(sql) ? "" : `INDEXED BY ${index}`);

/** SQLite uses this join spelling to retain loop order; PostgreSQL requires INNER JOIN with ON. */
export const orderedJoin = (sql: SqlClient.SqlClient): Fragment =>
  sql.literal(isPostgres(sql) ? "INNER JOIN" : "CROSS JOIN");

export const booleanLiteral = (sql: SqlClient.SqlClient, value: boolean): Fragment =>
  sql.literal(isPostgres(sql) ? String(value) : value ? "1" : "0");

/** Preserve arrays, objects, numbers and JSON null when copying a value into a JSON update. */
export const jsonValue = (sql: SqlClient.SqlClient, document: Fragment, path: string): Fragment =>
  isPostgres(sql)
    ? sql`jsonb_path_query_first(CAST(${document} AS jsonb), CAST(${path} AS jsonpath))`
    : sql`json_extract(${document}, ${path})`;
