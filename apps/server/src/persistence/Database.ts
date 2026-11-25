import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Postgres from "./Postgres.ts";
import * as Sqlite from "./Sqlite.ts";
import * as StorageConfig from "./StorageConfig.ts";

type Configured = Layer.Layer<
  SqlClient.SqlClient,
  Layer.Error<typeof Sqlite.layerCliConfig> | Layer.Error<ReturnType<typeof Postgres.layer>>,
  Layer.Services<typeof Sqlite.layerCliConfig>
>;

const configured = (sqlite: typeof Sqlite.layerConfig | typeof Sqlite.layerCliConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const storage = yield* StorageConfig.StorageConfig;
      if (storage.backend === "sqlite") return sqlite as Configured;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
      return Postgres.layer({
        url: storage.postgresUrl!,
        schema: storage.schema,
        poolSize: storage.poolSize,
        environmentId: yield* identity.getEnvironmentId,
        allowInitialize: !(yield* fs.exists(config.dbPath)),
      }) as Configured;
    }),
  ).pipe(Layer.provide(StorageConfig.layer), Layer.provide(ServerEnvironment.layerIdentity));

export const layerConfig = configured(Sqlite.layerConfig);
export const layerCliConfig = configured(Sqlite.layerCliConfig);
