import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as StorageConfig from "./StorageConfig.ts";

const configured = (env: Record<string, string>) =>
  StorageConfig.make().pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  );

it.effect(
  "selects an explicit PostgreSQL authority and keeps connection credentials redacted",
  () =>
    Effect.gen(function* () {
      const local = yield* configured({});
      assert.equal(local.backend, "sqlite");
      const external = yield* configured({
        T3CODE_DATABASE_URL: "postgresql://fixture:fixture-only@example.invalid/stardust",
        T3CODE_REDIS_URL: "rediss://example.invalid:6380",
      });
      assert.equal(external.backend, "postgres");
      assert.isTrue(Redacted.isRedacted(external.postgresUrl));
      assert.isTrue(Redacted.isRedacted(external.redisUrl));
      assert.equal(String(external.postgresUrl), "<redacted>");
      assert.equal(external.poolSize, 8);
      const explicit = yield* configured({
        T3CODE_DATABASE_BACKEND: "sqlite",
        T3CODE_DATABASE_URL: "postgresql://example.invalid/stardust",
      });
      assert.equal(explicit.backend, "sqlite");
    }),
);

it.effect("rejects missing authority settings and unsafe or unbounded options", () =>
  Effect.gen(function* () {
    for (const [env, field, reason] of [
      [{ T3CODE_DATABASE_BACKEND: "other" }, "T3CODE_DATABASE_BACKEND", "unsupported-backend"],
      [{ T3CODE_DATABASE_BACKEND: "postgres" }, "T3CODE_DATABASE_URL", "missing-url"],
      [{ T3CODE_DATABASE_URL: "https://example.invalid/db" }, "T3CODE_DATABASE_URL", "invalid-url"],
      [
        { T3CODE_POSTGRES_SCHEMA: "public,pg_catalog" },
        "T3CODE_POSTGRES_SCHEMA",
        "invalid-namespace",
      ],
      [{ T3CODE_CACHE_NAMESPACE: "other:*" }, "T3CODE_CACHE_NAMESPACE", "invalid-namespace"],
      [{ T3CODE_POSTGRES_POOL_SIZE: "65" }, "T3CODE_POSTGRES_POOL_SIZE", "invalid-limit"],
      [{ T3CODE_CACHE_TTL_SECONDS: "0" }, "T3CODE_CACHE_TTL_SECONDS", "invalid-limit"],
    ] as const) {
      const failure = yield* configured(env).pipe(Effect.flip);
      assert.instanceOf(failure, StorageConfig.StorageConfigurationError);
      assert.equal(failure.field, field);
      assert.equal(failure.reason, reason);
    }
  }),
);
