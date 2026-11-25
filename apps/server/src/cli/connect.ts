import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Flag, GlobalFlag, Prompt } from "effect/cli";
import { HttpClient, FetchHttpClient } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as CliService from "./service.ts";
import { resolveCliAuthConfig } from "./config.ts";

class AccountRemovedError extends Schema.TaggedError<AccountRemovedError>()(
  "AccountRemovedError",
  {},
) {
  override get message() {
    return "T3 Connect accounts have been removed. Use direct environment pairing.";
  }
}

export const headlessFlag = Flag.Boolean("headless").pipe(Flag.withDefault(false));
export const connectSubcommands = [] as const;
export const requireConnectAllowed = Effect.fail(new AccountRemovedError({}));
export const waitForReachability = () => requireConnectAllowed;
export const linkEnvironmentForConnect = (_options: {
  readonly headless: boolean;
  readonly installRelayClient?: boolean;
}): Effect.Effect<{ readonly identity: string | null } | null, AccountRemovedError> =>
  requireConnectAllowed;
export const disconnectCloud = (_options: {
  readonly clearAuthorization: boolean;
}): Effect.Effect<{ readonly status: "not_running" | "failed" }> =>
  Effect.succeed({ status: "not_running" });

export const runCloudCommand = Effect.fn("cloud.cli.run_cloud_command")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | EnvironmentAuth.EnvironmentAuth
    | BootService.BootService
    | SecureRandom.SecureRandom
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironmentIdentity
    | ManagedPolicy.ManagedPolicy
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const layerRuntime = Layer.mergeAll(
    ServerSecretStore.layer,
    EnvironmentAuth.layerRuntime,
    CliService.layer(config),
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(layerRuntime));
});
