import { createClient } from "@redis/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Random from "effect/Random";

export interface RedisCacheOptions {
  readonly url: Redacted.Redacted<string>;
  readonly namespace: string;
  readonly ttlSeconds: number;
  readonly maxBytes: number;
  readonly requireConnection?: boolean;
}

export class RedisCacheConfigurationError extends Schema.TaggedError<RedisCacheConfigurationError>()(
  "RedisCacheConfigurationError",
  { field: Schema.Literals(["namespace", "ttlSeconds", "maxBytes"]) },
) {
  override get message(): string {
    return `Invalid Redis cache option: ${this.field}.`;
  }
}

const MAX_LISTED_KEYS = 10_000;
const COMMAND_TIMEOUT = Duration.seconds(2);

export const make = Effect.fn("RedisKeyValueStore.make")(function* (options: RedisCacheOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(options.namespace))
    return yield* new RedisCacheConfigurationError({ field: "namespace" });
  if (
    !Number.isSafeInteger(options.ttlSeconds) ||
    options.ttlSeconds < 1 ||
    options.ttlSeconds > 3600
  )
    return yield* new RedisCacheConfigurationError({ field: "ttlSeconds" });
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 16 * 1024 * 1024
  )
    return yield* new RedisCacheConfigurationError({ field: "maxBytes" });
  const prefix = `${options.namespace}:`;
  const client = createClient({
    url: Redacted.value(options.url),
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 5), 2000),
    },
  });
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let disconnected = false;
  client.on("error", () => {
    if (disconnected) return;
    disconnected = true;
    runFork(Effect.logWarning("Redis cache connection unavailable; reads will bypass the cache"));
  });
  client.on("ready", () => {
    if (disconnected) runFork(Effect.logInfo("Redis cache connection restored"));
    disconnected = false;
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (client.isOpen) client.destroy();
    }),
  );
  const connect = Effect.tryPromise({
    try: () => client.connect(),
    catch: (cause) =>
      new KeyValueStore.KeyValueStoreError({
        method: "connect",
        message: "Redis cache connection failed",
        cause,
      }),
  });
  if (options.requireConnection) yield* connect.pipe(Effect.timeout("5 seconds"));
  else yield* Effect.forkScoped(connect.pipe(Effect.catch(() => Effect.void)));

  const command = Effect.fn("RedisKeyValueStore.command")(
    <A>(method: string, evaluate: () => Promise<A>) =>
      Effect.suspend(() => {
        if (!client.isReady)
          return Effect.fail(
            new KeyValueStore.KeyValueStoreError({ method, message: "Redis cache is unavailable" }),
          );
        return Effect.tryPromise({
          try: evaluate,
          catch: (cause) =>
            new KeyValueStore.KeyValueStoreError({
              method,
              message: "Redis cache command failed",
              cause,
            }),
        }).pipe(
          Effect.timeout(COMMAND_TIMEOUT),
          Effect.mapError((cause) =>
            cause instanceof KeyValueStore.KeyValueStoreError
              ? cause
              : new KeyValueStore.KeyValueStoreError({
                  method,
                  message: "Redis cache command timed out",
                  cause,
                }),
          ),
        );
      }),
  );
  const keys = command("keys", async () => {
    const result = new Set<string>();
    for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 128 })) {
      for (const key of batch) {
        if (key.startsWith(prefix)) result.add(key.slice(prefix.length));
        if (result.size > MAX_LISTED_KEYS)
          throw new Error("Redis cache key listing exceeds its bound");
      }
    }
    return [...result];
  });
  const encoder = new TextEncoder();
  return KeyValueStore.makeStringOnly({
    get: (key) => command("get", async () => (await client.get(`${prefix}${key}`)) ?? undefined),
    set: Effect.fn("RedisKeyValueStore.set")(function* (key, value) {
      const ttl = Math.max(1, Math.floor(options.ttlSeconds * (0.9 + (yield* Random.next) * 0.1)));
      yield* command("set", async () => {
        if (encoder.encode(value).byteLength > options.maxBytes) {
          await client.unlink(`${prefix}${key}`);
          return;
        }
        await client.set(`${prefix}${key}`, value, { EX: ttl });
      });
    }),
    remove: (key) =>
      command("remove", async () => {
        await client.unlink(`${prefix}${key}`);
      }),
    keys,
    size: keys.pipe(Effect.map((value) => value.length)),
    clear: keys.pipe(
      Effect.flatMap((value) =>
        Effect.forEach(
          value,
          (key) =>
            command("clear", async () => {
              await client.unlink(`${prefix}${key}`);
            }),
          { concurrency: 8, discard: true },
        ),
      ),
    ),
  });
});
