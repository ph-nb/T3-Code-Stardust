// @effect-diagnostics nodeBuiltinImport:off -- Exports build-time contract defaults for the native runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  AuthStandardClientScopes,
  authScopeResponse,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  OrchestrationV2RuntimeRequest,
  ServerConfig,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

const encode = <S extends Schema.Top>(schema: S, input: unknown) => {
  const codec = Schema.toCodecJson(schema);
  return Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(input));
};
const at = "2026-01-01T00:00:00.000Z";
const auth = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "stardust_local",
};
const config = encode(ServerConfig, {
  environment: {
    environmentId: "native-local",
    label: "Windows",
    platform: { os: "windows", arch: "x64", machine: "desktop" },
    serverVersion: "0.1.0-preview.4",
    orchestrationProtocolVersion: 2,
    capabilities: { repositoryIdentity: false, threadStop: true },
  },
  auth,
  cwd: ".",
  keybindingsConfigPath: ".",
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: ".",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {},
  shellResumeCompletionMarker: true,
  threadResumeCompletionMarker: true,
});
const thread = {
  id: "thread",
  projectId: "project",
  title: "Thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "default" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: at,
  deletedAt: null,
};
const threadShell = encode(OrchestrationV2ThreadShell, {
  ...thread,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
});
const projection = encode(OrchestrationV2ThreadProjection, {
  thread,
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at,
});
const run = encode(OrchestrationV2Run, {
  id: "run",
  threadId: "thread",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: "message",
  rootNodeId: null,
  activeAttemptId: null,
  status: "queued",
  requestedAt: at,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});
const item = {
  id: "item",
  threadId: "thread",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  messageId: "message",
  text: "",
};
const output =
  JSON.stringify(
    {
      config,
      ...authScopeResponse(AuthStandardClientScopes),
      threadShell,
      projection,
      run,
      userItem: encode(OrchestrationV2TurnItem, {
        ...item,
        type: "user_message",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      }),
      assistantItem: encode(OrchestrationV2TurnItem, {
        ...item,
        type: "assistant_message",
        streaming: false,
      }),
      approvalItem: encode(OrchestrationV2TurnItem, {
        ...item,
        type: "approval_request",
        requestId: "request",
        requestKind: "command",
      }),
      runtimeRequest: encode(OrchestrationV2RuntimeRequest, {
        id: "request",
        nodeId: "node",
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: "session" },
        createdAt: at,
        resolvedAt: null,
      }),
      methods: { ...WS_METHODS, ...ORCHESTRATION_V2_WS_METHODS },
    },
    null,
    2,
  ) + "\n";
const destination = NodePath.resolve(
  import.meta.dirname,
  "../../../native/stardust/schema/local-client-defaults.json",
);
if (process.argv.includes("--check")) {
  if (
    JSON.stringify(JSON.parse(NodeFS.readFileSync(destination, "utf8"))) !==
    JSON.stringify(JSON.parse(output))
  )
    throw new Error("Native local contract defaults are stale");
} else {
  NodeFS.writeFileSync(destination, output);
}
