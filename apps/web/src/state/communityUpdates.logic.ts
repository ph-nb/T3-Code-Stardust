import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { uiText } from "../i18n";
/** Community releases are independent of upstream Electron version numbers. */
/** The community release this build ships as. Bump with every public release. */
export const COMMUNITY_BASE_TAG = "v1.2.3";
export const COMMUNITY_REPOSITORY = "ph-nb/T3-Code-Stardust";
export const COMMUNITY_RELEASES_URL = `https://github.com/${COMMUNITY_REPOSITORY}/releases`;
export const COMMUNITY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export type CommunityUpdateMode = "standard" | "custom";
export interface CommunityRelease {
  tag: string;
  number: number;
  url: string;
  compareUrl: string;
}
/**
 * Maps community release tags onto a monotonically increasing integer order:
 * - Legacy C-series tags: `xiaoxin-c48-macos-20261112` -> 48
 * - Stardust semver tags (major >= 1): `v1.0.0` -> 1_010_000 (keeps upstream `v0.x.y` tags rejected)
 */
export function communityReleaseNumber(tag: string): number | null {
  const legacy = /^xiaoxin-c([1-9]\d*)-macos-\d{8}$/.exec(tag);
  if (legacy) {
    const number = Number(legacy[1]);
    return Number.isSafeInteger(number) ? number : null;
  }
  const semver = /^v([1-9]\d*)\.(\d+)\.(\d+)$/.exec(tag);
  if (semver) {
    const major = Number(semver[1]);
    const minor = Number(semver[2]);
    const patch = Number(semver[3]);
    if (minor < 100 && patch < 100) {
      const encoded = 1_000_000 + major * 10_000 + minor * 100 + patch;
      return Number.isSafeInteger(encoded) ? encoded : null;
    }
  }
  return null;
}
export interface CommunityReleaseTarget {
  readonly platform: "mac" | "win" | "linux";
  readonly arch: "arm64" | "x64";
}
export function communityReleaseTarget(platform: string, arch = "x64"): CommunityReleaseTarget {
  return {
    platform: /^(win|windows)/i.test(platform) ? "win" : /linux/i.test(platform) ? "linux" : "mac",
    arch: /arm64|aarch64/i.test(arch) ? "arm64" : "x64",
  };
}
function expectedAssetNames(
  tag: string,
  number: number,
  target: CommunityReleaseTarget,
): ReadonlyArray<string> {
  const semver = /^v([1-9]\d*\.\d+\.\d+)$/.exec(tag);
  if (semver) {
    const stem = `Stardust-${semver[1]}-${target.platform}-${target.arch}`;
    if (target.platform === "win") return [`${stem}.exe`];
    if (target.platform === "linux") {
      const appImageArch = target.arch === "x64" ? "x86_64" : "arm64";
      const debArch = target.arch === "x64" ? "amd64" : "arm64";
      return [
        `${stem}.AppImage`,
        `${stem}.deb`,
        `Stardust-${target.arch}.AppImage`,
        `Stardust-${appImageArch}.AppImage`,
        `Stardust-${semver[1]}-linux-${appImageArch}.AppImage`,
        `Stardust-${semver[1]}-linux-${debArch}.deb`,
      ];
    }
    return [
      `${stem}.zip`,
      `${stem}.dmg`,
      ...(target.arch === "arm64"
        ? [`T3-Stardust-v${semver[1]}-macOS-arm64.zip`, `T3-Stardust-${semver[1]}-macOS-arm64.zip`]
        : []),
    ];
  }
  return target.platform === "mac" && target.arch === "arm64"
    ? [`Xiaoxin-T3-Code-C${number}-macOS-arm64.zip`]
    : [];
}
export function parseCommunityRelease(
  value: unknown,
  target: CommunityReleaseTarget = { platform: "mac", arch: "arm64" },
): CommunityRelease {
  if (!value || typeof value !== "object") throw new Error(uiText("Invalid release information"));
  const release = value as Record<string, unknown>;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const number = communityReleaseNumber(tag);
  if (number === null || release.draft !== false || release.prerelease !== false) {
    throw new Error(uiText("The latest release is unavailable for this platform"));
  }
  const allowedAssetNames = expectedAssetNames(tag, number, target);
  if (
    !Array.isArray(release.assets) ||
    !release.assets.some((asset: unknown) => {
      if (!asset || typeof asset !== "object") return false;
      const file = asset as Record<string, unknown>;
      return (
        typeof file.name === "string" &&
        allowedAssetNames.includes(file.name) &&
        file.state === "uploaded" &&
        typeof file.size === "number" &&
        file.size > 0 &&
        typeof file.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(file.digest)
      );
    })
  )
    throw new Error(uiText("No complete, verifiable build is available for this platform"));
  // Construct trusted URLs; do not follow arbitrary URLs supplied by a response.
  return {
    tag,
    number,
    url: `${COMMUNITY_RELEASES_URL}/tag/${tag}`,
    compareUrl: `https://github.com/${COMMUNITY_REPOSITORY}/compare/${COMMUNITY_BASE_TAG}...${tag}`,
  };
}
/**
 * `canSelfUpdate`: the desktop app can install releases itself (T3 Stardust's macOS updater).
 * Source mode never installs, since replacing the app can overwrite a customized fork.
 */
export function communityUpdateActions(mode: CommunityUpdateMode, canSelfUpdate = false) {
  return {
    canOpenDownloadPage: mode === "standard",
    canViewSourceDiff: mode === "custom",
    canInstall: mode === "standard" && canSelfUpdate,
  };
}

/** True when the desktop shell runs its own updater, which Stardust builds only do on macOS. */
export function desktopCanSelfUpdate(state: DesktopUpdateState | null): boolean {
  return state !== null && state.enabled && state.status !== "disabled";
}

export type CommunityInstallPhase = "none" | "ready" | "downloading" | "downloaded";

export function communityInstallPhase(state: DesktopUpdateState | null): CommunityInstallPhase {
  if (!desktopCanSelfUpdate(state) || state === null) return "none";
  if (state.status === "downloading") return "downloading";
  if (state.downloadedVersion !== null) return "downloaded";
  if (state.status === "available" || (state.status === "error" && state.availableVersion)) {
    return "ready";
  }
  return "none";
}

/** The version a one-click update would install, if the desktop updater has found one. */
export function communityOfferedVersion(state: DesktopUpdateState | null): string | null {
  return state?.downloadedVersion ?? state?.availableVersion ?? null;
}

type CommunityUpdateBridge = Pick<
  DesktopBridge,
  "getUpdateState" | "checkForUpdate" | "downloadUpdate" | "installUpdate" | "onUpdateState"
>;

export type CommunityUpdateAndRestartResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string | null };

function waitWhileDownloading(
  bridge: CommunityUpdateBridge,
  current: DesktopUpdateState,
): Promise<DesktopUpdateState> {
  if (current.status !== "downloading") return Promise.resolve(current);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: DesktopUpdateState) => {
      if (settled || state.status === "downloading") return;
      settled = true;
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = bridge.onUpdateState(finish);
    // The download can finish between the caller's read and the subscription.
    void bridge.getUpdateState().then(finish, () => undefined);
  });
}

const hasInstallableDownload = (state: DesktopUpdateState) =>
  state.downloadedVersion !== null &&
  (state.status === "downloaded" ||
    (state.status === "error" &&
      (state.errorContext === null || state.errorContext === "install")));

/**
 * One click: find, download and verify the release, then quit, swap the app and relaunch.
 * Resolves after the desktop accepted the install (the app is quitting) or with why it could not.
 */
export async function runCommunityUpdateAndRestart(
  bridge: CommunityUpdateBridge,
): Promise<CommunityUpdateAndRestartResult> {
  let state = await bridge.getUpdateState();
  if (!desktopCanSelfUpdate(state)) return { ok: false, message: state.message };
  if (
    state.downloadedVersion === null &&
    state.status !== "available" &&
    state.status !== "downloading"
  ) {
    state = (await bridge.checkForUpdate()).state;
  }
  state = await waitWhileDownloading(bridge, state);
  if (!hasInstallableDownload(state) && state.availableVersion !== null) {
    state = (await bridge.downloadUpdate()).state;
    state = await waitWhileDownloading(bridge, state);
  }
  if (!hasInstallableDownload(state) || state.downloadedVersion === null) {
    return { ok: false, message: state.message };
  }
  const version = state.downloadedVersion;
  const result = await bridge.installUpdate(version);
  if (!result.accepted || result.state.status === "error") {
    return { ok: false, message: result.state.message };
  }
  return { ok: true, version };
}
