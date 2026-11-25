import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class StorageConfigurationError extends Schema.TaggedError<StorageConfigurationError>()(
  "StorageConfigurationError",
  {
    field: Schema.String,
    reason: Schema.Literals([
      "unsupported-backend",
      "missing-url",
      "invalid-url",
      "invalid-namespace",
      "invalid-limit",
    ]),
  },
) {
  override get message(): string {
    return `Invalid server storage configuration: ${this.field} (${this.reason}).`;
  }
}

export interface StorageOptions {
  readonly backend: "sqlite" | "postgres";
  readonly postgresUrl: Redacted.Redacted<string> | undefined;
  readonly schema: string;
  readonly poolSize: number;
  readonly redisUrl: Redacted.Redacted<string> | undefined;
  readonly cacheNamespace: string;
  readonly cacheTtlSeconds: number;
  readonly cacheMaxBytes: number;
}

export class StorageConfig extends Context.Service<StorageConfig, StorageOptions>()(
  "t3/persistence/StorageConfig",
) {}

const environment = Config.all({
  backend: Config.String("T3CODE_DATABASE_BACKEND").pipe(Config.withDefault("auto")),
  postgresUrl: Config.Redacted("T3CODE_DATABASE_URL").pipe(Config.option),
  schema: Config.String("T3CODE_POSTGRES_SCHEMA").pipe(Config.withDefault("stardust")),
  poolSize: Config.Int("T3CODE_POSTGRES_POOL_SIZE").pipe(Config.withDefault(8)),
  redisUrl: Config.Redacted("T3CODE_REDIS_URL").pipe(Config.option),
  cacheNamespace: Config.String("T3CODE_CACHE_NAMESPACE").pipe(Config.withDefault("stardust")),
  cacheTtlSeconds: Config.Int("T3CODE_CACHE_TTL_SECONDS").pipe(Config.withDefault(90)),
  cacheMaxBytes: Config.Int("T3CODE_CACHE_MAX_BYTES").pipe(Config.withDefault(1024 * 1024)),
});

export const make = Effect.fn("StorageConfig.make")(function* () {
  const value = yield* environment;
  if (value.backend !== "auto" && value.backend !== "sqlite" && value.backend !== "postgres")
    return yield* new StorageConfigurationError({
      field: "T3CODE_DATABASE_BACKEND",
      reason: "unsupported-backend",
    });
  const postgresUrl = Option.getOrUndefined(value.postgresUrl);
  const redisUrl = Option.getOrUndefined(value.redisUrl);
  const backend =
    value.backend === "auto" ? (postgresUrl === undefined ? "sqlite" : "postgres") : value.backend;
  if (backend === "postgres" && !postgresUrl)
    return yield* new StorageConfigurationError({
      field: "T3CODE_DATABASE_URL",
      reason: "missing-url",
    });
  for (const [field, url, protocols] of [
    ["T3CODE_DATABASE_URL", postgresUrl, ["postgres:", "postgresql:"]],
    ["T3CODE_REDIS_URL", redisUrl, ["redis:", "rediss:"]],
  ] as const) {
    if (url === undefined) continue;
    const parsed = yield* Effect.try({
      try: () => new URL(Redacted.value(url)),
      catch: () => new StorageConfigurationError({ field, reason: "invalid-url" }),
    });
    if (!(protocols as ReadonlyArray<string>).includes(parsed.protocol) || !parsed.hostname)
      return yield* new StorageConfigurationError({ field, reason: "invalid-url" });
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value.schema))
    return yield* new StorageConfigurationError({
      field: "T3CODE_POSTGRES_SCHEMA",
      reason: "invalid-namespace",
    });
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.cacheNamespace))
    return yield* new StorageConfigurationError({
      field: "T3CODE_CACHE_NAMESPACE",
      reason: "invalid-namespace",
    });
  for (const [field, limit, maximum] of [
    ["T3CODE_POSTGRES_POOL_SIZE", value.poolSize, 64],
    ["T3CODE_CACHE_TTL_SECONDS", value.cacheTtlSeconds, 3600],
    ["T3CODE_CACHE_MAX_BYTES", value.cacheMaxBytes, 16 * 1024 * 1024],
  ] as const) {
    if (limit < 1 || limit > maximum)
      return yield* new StorageConfigurationError({ field, reason: "invalid-limit" });
  }
  return StorageConfig.of({ ...value, backend, postgresUrl, redisUrl });
});

export const layer = Layer.effect(StorageConfig, make());
