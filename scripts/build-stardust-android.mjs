import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const mobileRoot = NodePath.join(root, "apps/mobile");
const requireMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const env = {
  ...process.env,
  APP_VARIANT: "production",
  T3CODE_MOBILE_VERSION: "1.2.3",
  T3CODE_MOBILE_UPDATES_ENABLED: "0",
  EXPO_NO_GIT_STATUS: "1",
  CI: "1",
};

function run(command, args, cwd) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  process.execPath,
  [NodePath.join(mobileRoot, "scripts/generate-uniwind-themes.mts")],
  mobileRoot,
);
run(
  process.execPath,
  [requireMobile.resolve("expo/bin/cli"), "prebuild", "--platform", "android", "--no-install"],
  mobileRoot,
);
const androidRoot = NodePath.join(mobileRoot, "android");
// oxlint-disable-next-line t3code/no-global-process-runtime -- selects the native Gradle wrapper before an application runtime exists.
if (process.platform === "win32") {
  run(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", "gradlew.bat", ":app:assembleRelease", "--no-daemon"],
    androidRoot,
  );
} else {
  run("sh", ["./gradlew", ":app:assembleRelease", "--no-daemon"], androidRoot);
}
const output = NodePath.join(root, "release");
NodeFS.mkdirSync(output, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(androidRoot, "app/build/outputs/apk/release/app-release.apk"),
  NodePath.join(output, "Stardust-1.2.3-android.apk"),
);
