// @effect-diagnostics nodeBuiltinImport:off -- Starts an isolated native binary and validates its wire responses against the client contracts.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import {
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  Project,
  ServerConfig,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadStreamItem,
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
  ProviderAuthState,
  ServerProviderUpdatedPayload,
} from "@t3tools/contracts";

const Frame = Schema.Struct({
  _tag: Schema.String,
  requestId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  values: Schema.optional(Schema.Array(Schema.Unknown)),
  exit: Schema.optional(
    Schema.Struct({
      _tag: Schema.String,
      value: Schema.optional(Schema.Unknown),
      cause: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decoders = new Map<Schema.Top, (value: unknown) => unknown>([
  [Frame, Schema.decodeUnknownSync(Frame)],
  [AuthSessionState, Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState))],
  [
    ExecutionEnvironmentDescriptor,
    Schema.decodeUnknownSync(Schema.toCodecJson(ExecutionEnvironmentDescriptor)),
  ],
  [Project, Schema.decodeUnknownSync(Schema.toCodecJson(Project))],
  [ServerConfig, Schema.decodeUnknownSync(Schema.toCodecJson(ServerConfig))],
  [
    OrchestrationV2DispatchCommandResult,
    Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2DispatchCommandResult)),
  ],
  [
    OrchestrationV2ThreadProjection,
    Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadProjection)),
  ],
  [
    OrchestrationV2ShellStreamItem,
    Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem)),
  ],
  [
    OrchestrationV2ThreadStreamItem,
    Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem)),
  ],
  [ServerConfigStreamEvent, Schema.decodeUnknownSync(Schema.toCodecJson(ServerConfigStreamEvent))],
  [
    ServerLifecycleStreamEvent,
    Schema.decodeUnknownSync(Schema.toCodecJson(ServerLifecycleStreamEvent)),
  ],
  [ProviderAuthState, Schema.decodeUnknownSync(Schema.toCodecJson(ProviderAuthState))],
  [
    ServerProviderUpdatedPayload,
    Schema.decodeUnknownSync(Schema.toCodecJson(ServerProviderUpdatedPayload)),
  ],
]);
const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] => {
  const decoder = decoders.get(schema);
  if (!decoder) throw new Error("Unregistered native wire schema");
  return decoder(value) as S["Type"];
};

const root = NodePath.resolve(import.meta.dirname, "../../..");
const executable = process.env.STARDUST_LOCAL_BINARY ?? process.argv[2];
if (!executable)
  throw new Error("Pass the stardust-local binary path or set STARDUST_LOCAL_BINARY");
await NodeFSP.mkdir(NodePath.join(root, ".t3"), { recursive: true });
const directory = await NodeFSP.mkdtemp(NodePath.join(root, ".t3/native-local-proof-"));
const workspace = NodePath.join(directory, "workspace");
await NodeFSP.mkdir(workspace);
const bootstrapFile = NodePath.join(directory, "bootstrap-url");
const child = NodeChildProcess.spawn(
  executable,
  ["--state-dir", NodePath.join(directory, "state"), "--bootstrap-file", bootstrapFile],
  {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, STARDUST_TEST_REPLAY: "1" },
  },
);
const lines = NodeReadline.createInterface({ input: child.stdout });
let socket: WebSocket | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Native local server exited during startup (${code})`)),
    );
    lines.on("line", (line) => {
      if (line.startsWith("local-listener=")) resolve();
    });
  });
  const launch = new URL(await NodeFSP.readFile(bootstrapFile, "utf8"));
  const origin = launch.origin;
  const descriptor = decode(
    ExecutionEnvironmentDescriptor,
    await (await fetch(origin + "/.well-known/t3/environment")).json(),
  );
  const anonymous = decode(
    AuthSessionState,
    await (await fetch(origin + "/api/auth/session")).json(),
  );
  NodeAssert.equal(anonymous.authenticated, false);
  const credential = new URLSearchParams(launch.hash.slice(1)).get("token");
  const login = await fetch(origin + "/api/auth/browser-session", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ credential }),
  });
  NodeAssert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  NodeAssert.ok(cookie);
  const headers = { cookie, origin, "content-type": "application/json" };
  const replay = await fetch(origin + "/api/auth/browser-session", {
    method: "POST",
    headers,
    body: JSON.stringify({ credential }),
  });
  NodeAssert.equal(replay.status, 401);
  const authenticated = decode(
    AuthSessionState,
    await (await fetch(origin + "/api/auth/session", { headers })).json(),
  );
  NodeAssert.equal(authenticated.authenticated, true);
  const projectInput = {
    type: "project.create",
    commandId: "create-project",
    projectId: "native-project",
    title: "Native local proof",
    workspaceRoot: workspace,
  };
  const rejected = await fetch(origin + "/api/projects/mutate", {
    method: "POST",
    headers: { ...headers, origin: "https://untrusted.example" },
    body: JSON.stringify(projectInput),
  });
  NodeAssert.equal(rejected.status, 401);
  const projectResponse = await fetch(origin + "/api/projects/mutate", {
    method: "POST",
    headers,
    body: JSON.stringify(projectInput),
  });
  NodeAssert.equal(projectResponse.status, 200);
  const project = decode(Project, await projectResponse.json());
  NodeAssert.equal(project.id, "native-project");
  const ticket = (await (
    await fetch(origin + "/api/auth/websocket-ticket/rpc", { method: "POST", headers })
  ).json()) as { ticket: string };
  const url = new URL(origin.replace("http:", "ws:") + "/ws");
  url.searchParams.set("wsTicket", ticket.ticket);
  socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("Native socket did not open")), {
      once: true,
    });
  });
  let counter = 0;
  const requests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fatal = Promise.withResolvers<never>();
  const checked = <A>(promise: Promise<A>) => Promise.race([promise, fatal.promise]);
  const streams = new Map<string, (value: unknown) => void>();
  socket.addEventListener("message", (event) => {
    try {
      const frame = decode(Frame, JSON.parse(String(event.data)));
      const id = String(frame.requestId);
      if (frame._tag === "Chunk") {
        for (const value of frame.values ?? []) streams.get(id)?.(value);
        socket!.send(JSON.stringify({ _tag: "Ack", requestId: id }));
      }
      if (frame._tag === "Exit") {
        const request = requests.get(id);
        requests.delete(id);
        if (frame.exit?._tag === "Success") request?.resolve(frame.exit.value);
        else request?.reject(new Error("Native RPC failed"));
      }
    } catch (error) {
      fatal.reject(error);
      for (const request of requests.values())
        request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const rpc = (tag: string, payload: unknown) =>
    checked(
      new Promise<unknown>((resolve, reject) => {
        const id = String(++counter);
        requests.set(id, { resolve, reject });
        socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      }),
    );
  const once = <S extends Schema.Top>(tag: string, payload: unknown, schema: S) =>
    checked(
      new Promise<S["Type"]>((resolve) => {
        const id = String(++counter);
        streams.set(id, (value) => resolve(decode(schema, value)));
        socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      }),
    );
  const config = decode(ServerConfig, await rpc("server.getConfig", {}));
  NodeAssert.equal(config.environment.environmentId, descriptor.environmentId);
  await once("subscribeServerConfig", {}, ServerConfigStreamEvent);
  await once("subscribeServerLifecycle", {}, ServerLifecycleStreamEvent);
  const auth = await once("provider.auth.subscribe", { instanceId: "codex" }, ProviderAuthState);
  NodeAssert.equal(auth.phase, "idle");
  const providers = decode(ServerProviderUpdatedPayload, await rpc("server.refreshProviders", {}));
  NodeAssert.ok(providers.providers.some((provider) => provider.instanceId === "devReplay"));
  const threadInput = {
    type: "thread.create",
    commandId: "create-thread",
    threadId: "native-thread",
    projectId: project.id,
    title: "Local thread",
    modelSelection: { instanceId: "codex", model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };
  decode(
    OrchestrationV2DispatchCommandResult,
    await rpc("orchestration.dispatchCommand", threadInput),
  );
  const projection = decode(
    OrchestrationV2ThreadProjection,
    await rpc("orchestration.getThreadProjection", { threadId: "native-thread" }),
  );
  NodeAssert.equal(projection.thread.title, "Local thread");
  const shellSnapshot = await checked(
    new Promise<unknown>((resolve) => {
      const id = String(++counter);
      streams.set(id, (value) => {
        const frame = decode(OrchestrationV2ShellStreamItem, value);
        if (frame.kind === "snapshot") resolve(frame.snapshot);
      });
      socket!.send(
        JSON.stringify({
          _tag: "Request",
          id,
          tag: "orchestration.subscribeShell",
          payload: {},
          headers: [],
        }),
      );
    }),
  );
  NodeAssert.ok(shellSnapshot);
  const events: unknown[] = [];
  const milestones: Array<{ matches: (frame: unknown) => boolean; resolve: () => void }> = [];
  const awaitRun = (messageId: string, status: string) =>
    checked(
      new Promise<void>((resolve) => {
        const matches = (frame: unknown) => {
          const item = decode(OrchestrationV2ThreadStreamItem, frame);
          return (
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.userMessageId === messageId &&
            (item.event.payload.status === status ||
              (status === "terminal" &&
                ["completed", "interrupted", "failed", "cancelled"].includes(
                  item.event.payload.status,
                )))
          );
        };
        if (events.some(matches)) resolve();
        else milestones.push({ matches, resolve });
      }),
    );
  const threadSnapshot = await checked(
    new Promise<unknown>((resolve) => {
      const id = String(++counter);
      streams.set(id, (value) => {
        const frame = decode(OrchestrationV2ThreadStreamItem, value);
        events.push(value);
        for (const milestone of milestones) {
          if (milestone.matches(value)) milestone.resolve();
        }
        if (frame.kind === "snapshot") resolve(frame.projection);
      });
      socket!.send(
        JSON.stringify({
          _tag: "Request",
          id,
          tag: "orchestration.subscribeThread",
          payload: { threadId: "native-thread" },
          headers: [],
        }),
      );
    }),
  );
  NodeAssert.ok(threadSnapshot);
  const message = {
    type: "message.dispatch",
    commandId: "message-1",
    threadId: "native-thread",
    messageId: "user-1",
    text: "Replay the native pipeline",
    attachments: [],
    modelSelection: { instanceId: "devReplay", model: "showcase" },
    dispatchMode: { type: "start_immediately" },
  };
  const receipt = decode(
    OrchestrationV2DispatchCommandResult,
    await rpc("orchestration.dispatchCommand", message),
  );
  await awaitRun("user-1", "completed");
  NodeAssert.deepEqual(
    decode(
      OrchestrationV2DispatchCommandResult,
      await rpc("orchestration.dispatchCommand", message),
    ),
    receipt,
  );
  const completed = decode(
    OrchestrationV2ThreadProjection,
    await rpc("orchestration.getThreadProjection", { threadId: "native-thread" }),
  );
  NodeAssert.equal(completed.runs.length, 1);
  NodeAssert.equal(
    completed.turnItems.filter((item) => item.type === "assistant_message").length,
    1,
  );
  const held = {
    ...message,
    commandId: "message-2",
    messageId: "user-2",
    modelSelection: { instanceId: "devReplay", model: "hold" },
  };
  decode(OrchestrationV2DispatchCommandResult, await rpc("orchestration.dispatchCommand", held));
  await awaitRun("user-2", "running");
  decode(
    OrchestrationV2DispatchCommandResult,
    await rpc("orchestration.dispatchCommand", {
      type: "thread.stop",
      commandId: "stop-2",
      threadId: "native-thread",
    }),
  );
  await awaitRun("user-2", "interrupted");
  const approvalReady = checked(
    new Promise<void>((resolve) => {
      const matches = (value: unknown) => {
        const frame = decode(OrchestrationV2ThreadStreamItem, value);
        return (
          frame.kind === "snapshot" &&
          frame.projection.runtimeRequests.some((request) => request.status === "pending")
        );
      };
      if (events.some(matches)) resolve();
      else milestones.push({ matches, resolve });
    }),
  );
  await rpc("orchestration.dispatchCommand", {
    ...message,
    commandId: "message-3",
    messageId: "user-3",
    modelSelection: { instanceId: "devReplay", model: "approval" },
  });
  await approvalReady;
  const awaitingApproval = decode(
    OrchestrationV2ThreadProjection,
    await rpc("orchestration.getThreadProjection", { threadId: "native-thread" }),
  );
  const request = awaitingApproval.runtimeRequests.find((request) => request.status === "pending");
  NodeAssert.ok(request);
  await NodeAssert.rejects(() =>
    rpc("orchestration.dispatchCommand", {
      type: "runtime-request.respond",
      commandId: "wrong-thread-approval",
      threadId: "other-thread",
      requestId: request.id,
      decision: "accept",
    }),
  );
  const approval = {
    type: "runtime-request.respond",
    commandId: "approval-1",
    threadId: "native-thread",
    requestId: request.id,
    decision: "accept",
  };
  const approved = await rpc("orchestration.dispatchCommand", approval);
  await awaitRun("user-3", "completed");
  NodeAssert.deepEqual(await rpc("orchestration.dispatchCommand", approval), approved);
  const realModel = process.env.STARDUST_REAL_CODEX_MODEL;
  if (realModel) {
    const codex = providers.providers.find((provider) => provider.instanceId === "codex");
    NodeAssert.ok(
      codex?.models?.some((model) => model.slug === realModel),
      "Requested real test model is not in the Codex catalog",
    );
    const realWorkspace = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "stardust-native-agent-"),
    );
    const git = NodeChildProcess.spawnSync("git", ["-C", realWorkspace, "init"], {
      stdio: "ignore",
      windowsHide: true,
    });
    NodeAssert.equal(git.status, 0);
    const realProject = decode(
      Project,
      await (
        await fetch(origin + "/api/projects/mutate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "project.create",
            commandId: "real-project-create",
            projectId: "real-project",
            title: "Native Codex verification",
            workspaceRoot: realWorkspace,
          }),
        })
      ).json(),
    );
    await rpc("orchestration.dispatchCommand", {
      ...threadInput,
      commandId: "real-thread-create",
      threadId: "real-thread",
      projectId: realProject.id,
      modelSelection: { instanceId: "codex", model: realModel },
    });
    await checked(
      new Promise<void>((resolve) => {
        const id = String(++counter);
        streams.set(id, (value) => {
          decode(OrchestrationV2ThreadStreamItem, value);
          events.push(value);
          for (const milestone of milestones) {
            if (milestone.matches(value)) milestone.resolve();
          }
          resolve();
        });
        socket!.send(
          JSON.stringify({
            _tag: "Request",
            id,
            tag: "orchestration.subscribeThread",
            payload: { threadId: "real-thread" },
            headers: [],
          }),
        );
      }),
    );
    await rpc("orchestration.dispatchCommand", {
      ...message,
      commandId: "real-message",
      threadId: "real-thread",
      messageId: "real-user",
      text: "Verification fixture: in the current workspace create native-rust-local-proof.txt containing exactly native-rust-local-ok followed by a newline. Do not access any other project or network. Reply only OK after saving it.",
      modelSelection: {
        instanceId: "codex",
        model: realModel,
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });
    await awaitRun("real-user", "terminal");
    const realProjection = decode(
      OrchestrationV2ThreadProjection,
      await rpc("orchestration.getThreadProjection", { threadId: "real-thread" }),
    );
    const realRun = realProjection.runs.find((run) => run.userMessageId === "real-user");
    NodeAssert.equal(realRun?.status, "completed");
    NodeAssert.equal(
      (await NodeFSP.readFile(NodePath.join(realWorkspace, "native-rust-local-proof.txt"), "utf8"))
        .trim()
        .replace(/^\uFEFF/, ""),
      "native-rust-local-ok",
    );
    NodeAssert.ok(
      realProjection.turnItems.some(
        (item) => item.type === "assistant_message" && item.text.trim().length > 0,
      ),
    );
    console.log(
      JSON.stringify({
        realCodex: "passed",
        model: realModel,
        workspace: realWorkspace,
        fileWritten: true,
      }),
    );
  }
  console.log(
    JSON.stringify({
      nativeLocal: "passed",
      authentication: "passed",
      project: "passed",
      thread: "passed",
      shellStream: "passed",
      threadStream: "passed",
      freeReplay: "passed",
      deduplication: "passed",
      cancellation: "passed",
      approval: "passed",
      providers: providers.providers.map((provider) => ({
        instanceId: provider.instanceId,
        status: provider.status,
        auth: provider.auth.status,
        models: provider.models?.length,
      })),
      stateDirectory: directory,
    }),
  );
} finally {
  socket?.close();
  lines.close();
  child.kill("SIGTERM");
}
