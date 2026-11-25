import { EnvironmentHttpApi, EnvironmentHttpForbiddenError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

const removed = () =>
  Effect.fail(
    new EnvironmentHttpForbiddenError({
      message: "T3 Connect accounts have been removed. Use direct environment pairing.",
    }),
  );

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "connect", (handlers) =>
  handlers
    .handle("linkProof", removed)
    .handle("relayConfig", removed)
    .handle("linkState", removed)
    .handle("checkReachability", removed)
    .handle("unlink", removed)
    .handle("preferences", removed)
    .handle("liveActivityPreference", removed)
    .handle("health", removed)
    .handle("t3MintCredential", removed),
);
