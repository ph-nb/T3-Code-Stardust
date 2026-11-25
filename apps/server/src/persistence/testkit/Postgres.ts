import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Postgres from "../Postgres.ts";

export const layerMemory = Layer.unwrap(
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const schema = `storage_test_${(yield* random.uuidV4()).replaceAll("-", "")}`;
    const url = yield* Config.String("STARDUST_TEST_POSTGRES_URL");
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.addFinalizer(() =>
          sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.orDie),
        );
      }),
    ).pipe(
      Layer.provideMerge(
        Postgres.layer({
          url: Redacted.make(url),
          schema,
          poolSize: 4,
          environmentId: "storage-test",
          allowInitialize: true,
        }),
      ),
    );
  }),
).pipe(Layer.provide(NodeCrypto.layer));
