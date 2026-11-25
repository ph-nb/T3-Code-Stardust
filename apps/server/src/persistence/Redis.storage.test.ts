import { createClient } from "@redis/client";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as PullRequestReadCache from "../pullRequest/PullRequestReadCache.ts";
import * as RedisKeyValueStore from "./RedisKeyValueStore.ts";

const connection = Effect.gen(function* () {
  const url = yield* Config.String("STARDUST_TEST_REDIS_URL");
  const random = yield* SecureRandom.SecureRandom;
  const namespace = `storage-test:${yield* random.uuidV4()}`;
  const raw = createClient({ url });
  raw.on("error", () => undefined);
  yield* Effect.acquireRelease(
    Effect.promise(() => raw.connect()),
    () =>
      Effect.sync(() => {
        raw.destroy();
      }),
  );
  const store = yield* RedisKeyValueStore.make({
    url: Redacted.make(url),
    namespace,
    ttlSeconds: 90,
    maxBytes: 1024,
    requireConnection: true,
  });
  yield* Effect.addFinalizer(() => store.clear.pipe(Effect.ignore));
  return { raw, store, namespace };
});

it.live("bounds Redis payloads and TTL and clears only the current environment namespace", () =>
  Effect.gen(function* () {
    const { raw, store, namespace } = yield* connection;
    yield* Effect.promise(() => raw.set(`${namespace}-other:keep`, "outside"));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => raw.unlink(`${namespace}-other:keep`)).pipe(Effect.asVoid),
    );
    yield* store.set("key", "中文缓存");
    assert.equal(yield* store.get("key"), "中文缓存");
    const ttl = yield* Effect.promise(() => raw.ttl(`${namespace}:key`));
    assert.isAtLeast(ttl, 1);
    assert.isAtMost(ttl, 90);
    yield* store.set("key", "大".repeat(1024));
    assert.isUndefined(yield* store.get("key"));
    yield* store.set("one", "1");
    yield* store.set("two", "2");
    assert.equal(yield* store.size, 2);
    yield* store.clear;
    assert.equal(yield* store.size, 0);
    assert.equal(yield* Effect.promise(() => raw.get(`${namespace}-other:keep`)), "outside");
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.live("bypasses a timed out Redis invalidation and resumes caching without stale PR data", () =>
  Effect.gen(function* () {
    const { raw, store } = yield* connection;
    const cache = yield* PullRequestReadCache.makeRedis.pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, store),
    );
    let lookups = 0;
    const lookup = Effect.sync(() => `revision-${++lookups}`);
    assert.equal(yield* cache.get("fixture-pr", lookup, ["fixture-scope"]), "revision-1");
    assert.equal(yield* cache.get("fixture-pr", lookup, ["fixture-scope"]), "revision-1");
    // A real Redis pause forces the adapter's command deadline; no test timer drives recovery.
    yield* Effect.promise(() => raw.sendCommand(["CLIENT", "PAUSE", "3000", "ALL"]));
    yield* cache.invalidate("fixture-scope");
    assert.equal(yield* cache.get("fixture-pr", lookup, ["fixture-scope"]), "revision-2");
    assert.equal(yield* cache.get("fixture-pr", lookup, ["fixture-scope"]), "revision-2");
    assert.equal(lookups, 2);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.live("serves authoritative reads when Redis cannot connect", () =>
  Effect.gen(function* () {
    const store = yield* RedisKeyValueStore.make({
      url: Redacted.make("redis://127.0.0.1:1"),
      namespace: "unavailable-test",
      ttlSeconds: 60,
      maxBytes: 1024,
    });
    const cache = yield* PullRequestReadCache.makeRedis.pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, store),
    );
    assert.equal(yield* cache.get("fixture", Effect.succeed("authority")), "authority");
    yield* cache.invalidate("scope");
    assert.equal(yield* cache.get("fixture", Effect.succeed("new-authority")), "new-authority");
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
