// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("keeps env precedence and discards removed account and vendor export settings", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "BUILD_LABEL=root\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_root\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "BUILD_LABEL=local\nVITE_RELAY_OTLP_TRACES_TOKEN=old-token\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).BUILD_LABEL).toBe("local");
    expect(
      loadRepoEnv({
        baseEnv: {
          BUILD_LABEL: "ci",
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "old",
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: "old",
        },
        repoRoot,
      }),
    ).toEqual({ BUILD_LABEL: "ci" });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stardust-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
