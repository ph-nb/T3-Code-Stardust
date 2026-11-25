import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as AuthPairingLinks from "./AuthPairingLinks.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";
import * as Postgres from "./Postgres.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as ServerConfig from "../config.ts";
import * as PostgresTest from "./testkit/Postgres.ts";

const now = DateTime.makeUnsafe("2026-11-23T00:00:00.000Z");
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("storage-project");
const thread = (id: string): OrchestrationV2AppThread => ({
  id: ThreadId.make(id),
  projectId,
  title: id,
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastVisitedAt: null,
});
const created = (id: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${id}`),
  type: "thread.created",
  threadId: ThreadId.make(id),
  occurredAt: now,
  payload: thread(id),
});
const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const domain = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const services = Layer.mergeAll(
  AuthPairingLinks.layer,
  ProviderSessionRuntime.layer,
  EffectOutbox.layer,
  ProjectStore.layer,
  OrchestrationEventStore.layer,
  ThreadSearch.layer,
  LegacyV1ThreadImporter.layer,
  ProjectionMaintenance.layer,
).pipe(
  Layer.provideMerge(domain),
  Layer.provideMerge(PostgresTest.layerMemory),
  Layer.provideMerge(platform),
);
const database = PostgresTest.layerMemory.pipe(Layer.provideMerge(platform));

it.live(
  "serializes application cursors through commit and preserves repeatable read snapshots",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      const allocated = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const result = yield* events.appendAgentEvents({ events: [created("first")] });
            yield* Deferred.succeed(allocated, undefined);
            yield* Deferred.await(release);
            return result[0]!.sequence;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(allocated);
      const second = yield* events
        .appendAgentEvents({ events: [created("second")] })
        .pipe(Effect.forkScoped);
      assert.equal(yield* events.latestApplicationSequence, 0);
      yield* Deferred.succeed(release, undefined);
      const firstSequence = yield* Fiber.join(first);
      const secondSequence = (yield* Fiber.join(second))[0]!.sequence;
      assert.isAbove(secondSequence, firstSequence);
      assert.deepEqual(
        (yield* events.readAgentEvents().pipe(Stream.runCollect)).map((event) => event.sequence),
        [firstSequence, secondSequence],
      );
      const inSnapshot = yield* Deferred.make<void>();
      const writeDone = yield* Deferred.make<void>();
      const reader = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* events.latestApplicationSequence;
            yield* Deferred.succeed(inSnapshot, undefined);
            yield* Deferred.await(writeDone);
            assert.equal(yield* events.latestApplicationSequence, before);
          }),
        )
        .pipe(NodeSqliteClient.readOnly, Effect.forkScoped);
      yield* Deferred.await(inSnapshot);
      yield* events.appendAgentEvents({ events: [created("third")] });
      yield* Deferred.succeed(writeDone, undefined);
      yield* Fiber.join(reader);
    }).pipe(Effect.provide(services)),
);

it.live("commits one receipt and outbox entry for duplicate commands and claims work once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const commandId = CommandId.make("same-command");
    const threadId = ThreadId.make("command-thread");
    const command = {
      commandId,
      threadId,
      commandType: "thread.create",
      acceptedAt: now,
      events: [created(threadId)],
      effects: [
        { id: "effect-once", commandId, threadId, request: { type: "terminal.cleanup" as const } },
      ],
    };
    yield* Effect.all(
      Array.from({ length: 8 }, () => sink.commitCommand(command)),
      { concurrency: "unbounded" },
    );
    for (const table of [
      "orchestration_events",
      "orchestration_command_receipts",
      "orchestration_v2_effect_outbox",
    ]) {
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`;
      assert.equal(rows[0]?.count, 1, table);
    }
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, (_, i) => outbox.claimNext({ workerId: `worker-${i}` })),
      { concurrency: "unbounded" },
    );
    assert.equal(claims.filter(Option.isSome).length, 1);
    const failure = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sink.write({ events: [created("rolled-back")] });
          yield* outbox.enqueue([
            {
              id: "rolled-back-effect",
              commandId: CommandId.make("rollback"),
              threadId: ThreadId.make("rolled-back"),
              request: { type: "terminal.cleanup" },
            },
          ]);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.flip);
    assert.equal(failure, "rollback");
    assert.deepEqual(
      yield* sql`SELECT 1 FROM orchestration_events WHERE stream_id = 'rolled-back'`,
      [],
    );
    assert.deepEqual(
      yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = 'rolled-back'`,
      [],
    );
    assert.deepEqual(
      yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id = 'rolled-back-effect'`,
      [],
    );
  }).pipe(Effect.provide(services)),
);

it.live("preserves JSON transcript arrays and consumes scoped pairing credentials once", () =>
  Effect.gen(function* () {
    const runtime = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const threadId = ThreadId.make("runtime");
    const base = {
      threadId,
      providerName: "codex",
      providerInstanceId: instanceId,
      adapterKey: "codex",
      runtimeMode: "full-access" as const,
      status: "running" as const,
      lastSeenAt: DateTime.formatIso(now),
      resumeCursor: null,
    };
    yield* runtime.upsert({ ...base, runtimePayload: { custom: { nested: [1, true, null] } } });
    const source = {
      provider: "codex" as const,
      providerInstanceId: instanceId,
      providerSessionId: "fixture-session",
      filePath: "/fixture/transcript.jsonl",
      size: 123,
      mtimeMs: 1,
      device: 1,
      inode: "123",
      birthtimeMs: null,
    };
    yield* runtime.recordImportedTranscript({ threadId, source });
    yield* runtime.recordImportedTranscript({ threadId, source });
    yield* runtime.upsert({ ...base, runtimePayload: { replacement: true } });
    const saved = yield* runtime.getByThreadId({ threadId });
    assert.deepEqual(Option.getOrThrow(saved).runtimePayload, {
      replacement: true,
      importedTranscripts: [source],
    });
    const links = yield* AuthPairingLinks.AuthPairingLinkRepository;
    yield* links.create({
      id: "fixture-link",
      credential: "fixture-only",
      method: "one-time-token",
      scopes: ["orchestration:read"],
      subject: "fixture",
      label: null,
      proofKeyThumbprint: null,
      createdAt: now,
      expiresAt: DateTime.makeUnsafe("2026-11-24T00:00:00.000Z"),
    });
    const denied = yield* links.consumeAvailable({
      credential: "fixture-only",
      proofKeyThumbprint: null,
      requestedScopes: ["access:write"],
      now,
      consumedAt: now,
    });
    assert.isTrue(Option.isNone(denied));
    const used = yield* Effect.all(
      Array.from({ length: 8 }, () =>
        links.consumeAvailable({
          credential: "fixture-only",
          proofKeyThumbprint: null,
          requestedScopes: ["orchestration:read"],
          now,
          consumedAt: now,
        }),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(used.filter(Option.isSome).length, 1);
  }).pipe(Effect.provide(services)),
);

it.live(
  "finds Chinese, kana, Cyrillic and readable identifiers with the native trigram index",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      yield* projects.apply({
        sequence: 1,
        type: "project.created",
        eventId: EventId.make("project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(now),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Storage",
          workspaceRoot: "/fixture",
          scripts: [],
          defaultModelSelection: null,
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      });
      const threadId = ThreadId.make("search");
      yield* projection.apply(created(threadId));
      const text = String.raw`中文部署 がんばって ОШИБКА fermée Fix [\_\_init\_\_.py](pkg/__init__.py)`;
      yield* projection.apply({
        id: EventId.make("message"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message"),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const query of ["部署", "がんばって", "ошибка", "fermee", "__init__.py"]) {
        assert.deepEqual(
          (yield* search.search({ query })).matches.map((match) => match.threadId),
          [threadId],
          query,
        );
      }
      assert.equal(
        (yield* sql`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'orchestration_v2_messages_text_trgm_idx'`)
          .length,
        1,
      );
    }).pipe(Effect.provide(services)),
);

it.live("rejects a second environment owner and an unrelated environment identity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const url = Redacted.make(yield* Config.String("STARDUST_TEST_POSTGRES_URL"));
    const schema = (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema;
    const ownerMonitor = yield* Postgres.holdOwnership({ url, schema });
    yield* ownerMonitor.pipe(Effect.forkScoped);
    const conflict = yield* Effect.scoped(
      Postgres.holdOwnership({ url, schema }).pipe(Effect.asVoid),
    ).pipe(Effect.flip);
    assert.equal(conflict._tag, "PostgresOwnershipError");
    const mismatch = yield* Postgres.migrate({
      url,
      schema,
      poolSize: 4,
      environmentId: "another-environment",
      allowInitialize: true,
    }).pipe(Effect.flip);
    assert.equal(mismatch._tag, "PostgresSchemaError");
  }).pipe(Effect.provide(database)),
);

it.live("maintains run and thread item counts when items move and runs disappear", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('counter-item', 'counter-thread', 'counter-run', 0, 'assistant_message', 'completed', '2026-11-23T00:00:00.000Z', '{}')`;
    assert.deepEqual(
      yield* sql`SELECT item_count FROM orchestration_v2_projection_turn_item_counts`,
      [{ item_count: 1 }],
    );
    assert.deepEqual(
      yield* sql`SELECT item_count FROM orchestration_v2_projection_thread_item_counts`,
      [],
    );
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('counter-run', 'counter-thread', 0, 'codex', 'completed', '2026-11-23T00:00:00.000Z', '{}')`;
    assert.deepEqual(
      yield* sql`SELECT thread_id, item_count FROM orchestration_v2_projection_thread_item_counts`,
      [{ thread_id: "counter-thread", item_count: 1 }],
    );
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET thread_id = 'moved-thread' WHERE turn_item_id = 'counter-item'`;
    assert.deepEqual(
      yield* sql`SELECT thread_id, item_count FROM orchestration_v2_projection_thread_item_counts`,
      [{ thread_id: "moved-thread", item_count: 1 }],
    );
    yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = 'counter-run'`;
    assert.deepEqual(
      yield* sql`SELECT item_count FROM orchestration_v2_projection_thread_item_counts`,
      [],
    );
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'counter-item'`;
    assert.deepEqual(
      yield* sql`SELECT item_count FROM orchestration_v2_projection_turn_item_counts`,
      [],
    );
  }).pipe(Effect.provide(database)),
);

it.live("fails the environment guard when its dedicated PostgreSQL connection is terminated", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const url = Redacted.make(yield* Config.String("STARDUST_TEST_POSTGRES_URL"));
    const schema = (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema;
    const monitor = yield* Postgres.holdOwnership({ url, schema });
    const observed = yield* monitor.pipe(Effect.result, Effect.forkScoped);
    const owner = yield* sql<{
      pid: number;
    }>`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = hashtext(${schema})::oid AND objid = 2 AND objsubid = 2 AND granted`;
    assert.lengthOf(owner, 1);
    yield* sql`SELECT pg_terminate_backend(${owner[0]!.pid})`;
    const result = yield* Fiber.join(observed);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.equal(result.failure.reason, "connection-lost");
  }).pipe(Effect.provide(database)),
);

it.live(
  "imports retained legacy conversations on startup and prunes history using PostgreSQL maintenance",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      assert.equal(yield* legacy.pendingThreadCount, 0);
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('legacy-project', '旧项目', '/fixture', '[]', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES ('legacy-thread', 'legacy-project', '旧对话', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('legacy-message', 'legacy-thread', 'user', '保留中文旧记录', 0, '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z')`;
      assert.equal(yield* legacy.pendingThreadCount, 1);
      yield* legacy.reconcileShells;
      yield* legacy.ensureTranscript(ThreadId.make("legacy-thread"));
      assert.deepEqual(
        (yield* projection.getThreadProjection(ThreadId.make("legacy-thread"))).messages.map(
          (message) => message.text,
        ),
        ["保留中文旧记录"],
      );
      const result = yield* maintenance.pruneEventStore();
      assert.isAtLeast(result.deletedEventCount, 0);
      assert.equal(result.reclaimableBytes, 0);
    }).pipe(Effect.provide(services)),
);

it.live("reports PostgreSQL capacity and rejects SQLite file reclamation", () =>
  Effect.gen(function* () {
    const storage = yield* DatabaseStorage.DatabaseStorage;
    const status = yield* storage.status.pipe(
      Stream.filter((value) => value !== null),
      Stream.runHead,
    );
    assert.isTrue(Option.isSome(status));
    if (Option.isSome(status)) {
      assert.isAbove(status.value.databaseBytes, 0);
      assert.isFalse(status.value.canReclaim);
      assert.isFalse(status.value.incrementalVacuumEnabled);
    }
    const rejected = yield* storage.requestReclaim.pipe(Effect.flip);
    assert.equal(rejected._tag, "DatabaseReclaimError");
  }).pipe(
    Effect.provide(
      DatabaseStorage.layer.pipe(
        Layer.provideMerge(services),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "postgres-storage-status-" }),
        ),
        Layer.provide(platform),
      ),
    ),
  ),
);

it.live("counts nested tool output bytes and removes optional history bodies", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("tool-byte-floor");
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('structured-tool', ${threadId}, 0, 'command_execution', 'completed', '2026-11-23T00:00:00.000Z', '{"output":{"stderr":"中文","parts":["abc",{"body":"def"}],"count":1}}')`;
    assert.equal(yield* projection.getTranscriptByteFloor(threadId, 0), 12);
    assert.equal(yield* projection.getTranscriptByteFloor(threadId, 10000), 0);
    const rows = yield* sql<{
      payload: string;
    }>`SELECT json_remove('{"history":{"large":"body"},"delivery":[],"keep":"yes"}', '$.history', '$.delivery') AS payload`;
    assert.deepEqual(decodeJson(rows[0]!.payload), { keep: "yes" });
  }).pipe(Effect.provide(services)),
);
