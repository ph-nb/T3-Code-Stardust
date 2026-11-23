import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";
import {
  communityInstallPhase,
  communityReleaseTarget,
  communityReleaseNumber,
  communityUpdateActions,
  desktopCanSelfUpdate,
  parseCommunityRelease,
  runCommunityUpdateAndRestart,
} from "./communityUpdates.logic";
const stardustRelease = (version = "1.0.1") => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: `T3-Stardust-${version}-macOS-arm64.zip`,
      state: "uploaded",
      size: 123,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
  html_url: "https://evil.example/",
});
const release = (number = 48) => ({
  tag_name: `xiaoxin-c${number}-macos-20261112`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: `Xiaoxin-T3-Code-C${number}-macOS-arm64.zip`,
      state: "uploaded",
      size: 123,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
  html_url: "https://evil.example/",
});
beforeEach(() => {
  vi.resetModules();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => saved.set(k, v),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("community release boundaries", () => {
  it("offers verified assets for the client OS and architecture", () => {
    const releases = [
      "Stardust-1.2.4-win-x64.exe",
      "Stardust-1.2.4-win-arm64.exe",
      "Stardust-1.2.4-linux-x64.AppImage",
      "Stardust-1.2.4-linux-arm64.deb",
    ];
    for (const platform of ["win", "linux"] as const) {
      for (const arch of ["x64", "arm64"] as const) {
        const matching = releases.find((name) => name.includes(`-${platform}-${arch}.`))!;
        const input = {
          ...stardustRelease("1.2.4"),
          assets: [{ ...stardustRelease().assets[0], name: matching }],
        };
        expect(parseCommunityRelease(input, { platform, arch }).tag).toBe("v1.2.4");
        expect(() => parseCommunityRelease(stardustRelease(), { platform, arch })).toThrow();
        expect(() =>
          parseCommunityRelease(input, { platform, arch: arch === "x64" ? "arm64" : "x64" }),
        ).toThrow();
      }
    }
    expect(communityReleaseTarget("win32", "arm64")).toEqual({ platform: "win", arch: "arm64" });
    expect(communityReleaseTarget("linux", "x64")).toEqual({ platform: "linux", arch: "x64" });
  });
  it("compares Stardust semver and legacy community numbers while rejecting upstream v0.x tags", () => {
    expect(communityReleaseNumber("xiaoxin-c100-macos-20261112")).toBe(100);
    expect(communityReleaseNumber("v1.0.0")).toBe(1_010_000);
    expect(communityReleaseNumber("v1.0.1")).toBeGreaterThan(communityReleaseNumber("v1.0.0")!);
    expect(communityReleaseNumber("v1.0.0")).toBeGreaterThan(
      communityReleaseNumber("xiaoxin-c100-macos-20261112")!,
    );
    expect(communityReleaseNumber("v0.1.9")).toBeNull();
    expect(communityReleaseNumber("xiaoxin-c48-windows-20261112")).toBeNull();
  });
  it("ignores arbitrary response URLs and builds repository-bound links", () => {
    const r = parseCommunityRelease(stardustRelease("1.2.4"));
    expect(r.url).toBe("https://github.com/ph-nb/T3-Code-Stardust/releases/tag/v1.2.4");
    expect(r.compareUrl).toContain("compare/v1.2.3...v1.2.4");
    const legacy = parseCommunityRelease(release());
    expect(legacy.url).toBe(
      "https://github.com/ph-nb/T3-Code-Stardust/releases/tag/xiaoxin-c48-macos-20261112",
    );
  });
  it.each([
    { ...stardustRelease(), draft: true },
    { ...stardustRelease(), prerelease: true },
    { ...stardustRelease(), assets: [] },
    { ...stardustRelease(), assets: [{ ...stardustRelease().assets[0], digest: "" }] },
  ])("rejects unpublished, preview or incomplete binaries", (r) =>
    expect(() => parseCommunityRelease(r)).toThrow(),
  );
  it("accepts the published asset name, which keeps the tag's v", () => {
    const published = stardustRelease("1.2.2");
    published.assets[0]!.name = "T3-Stardust-v1.2.2-macOS-arm64.zip";
    expect(parseCommunityRelease(published).tag).toBe("v1.2.2");
  });
  it("custom mode exposes only source review and never installation", () => {
    expect(communityUpdateActions("custom")).toEqual({
      canOpenDownloadPage: false,
      canViewSourceDiff: true,
      canInstall: false,
    });
    expect(communityUpdateActions("custom", true).canInstall).toBe(false);
    expect(communityUpdateActions("standard").canInstall).toBe(false);
    expect(communityUpdateActions("standard", true).canInstall).toBe(true);
  });
});
describe("community checks", () => {
  it("defaults to standard mode, performs credential-free checks, and finds a newer release", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => stardustRelease("1.2.4") });
    vi.stubGlobal("fetch", fetch);
    const { useCommunityUpdates: s } = await import("./communityUpdates");
    expect(s.getState().mode).toBe("standard");
    await s.getState().check();
    expect(s.getState().status).toBe("available");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    await s.getState().check();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["1.2.0", "1.0.11", "1.0.2"])(
    "does not offer the shipped or an older version (%s) as an upgrade",
    async (version) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => stardustRelease(version) }),
      );
      const { useCommunityUpdates: s } = await import("./communityUpdates");
      await s.getState().check(true);
      expect(s.getState().status).toBe("current");
    },
  );
  it("deduplicates simultaneous checks and preserves a mode change during the request", async () => {
    let resolve!: (r: unknown) => void;
    const fetch = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { useCommunityUpdates: s } = await import("./communityUpdates");
    s.getState().setMode("standard");
    const first = s.getState().check(true);
    const second = s.getState().check(true);
    s.getState().setMode("custom");
    resolve({ ok: true, json: async () => stardustRelease("1.0.1") });
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.getState().mode).toBe("custom");
  });
  it("respects disabled background checks while allowing an explicit manual check", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => stardustRelease("1.0.1") });
    vi.stubGlobal("fetch", fetch);
    const { useCommunityUpdates: s } = await import("./communityUpdates");
    s.getState().setAutomatic(false);
    await s.getState().check();
    expect(fetch).not.toHaveBeenCalled();
    await s.getState().check(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports network errors without starting another automatic request", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const { useCommunityUpdates: s } = await import("./communityUpdates");
    await s.getState().check();
    expect(s.getState()).toMatchObject({ status: "error", error: "offline" });
    await s.getState().check();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("corrupt preferences fail back to standard mode", async () => {
    localStorage.setItem("t3code:community-updates:v1", "invalid");
    const { useCommunityUpdates: s } = await import("./communityUpdates");
    expect(s.getState().mode).toBe("standard");
  });
  it("moves an unchosen legacy custom default to standard but keeps an explicit choice", async () => {
    localStorage.setItem(
      "t3code:community-updates:v1",
      JSON.stringify({ mode: "custom", automatic: true, lastAttempt: 0, notifiedTag: "" }),
    );
    const first = await import("./communityUpdates");
    expect(first.useCommunityUpdates.getState().mode).toBe("standard");
    first.useCommunityUpdates.getState().setMode("custom");
    vi.resetModules();
    const second = await import("./communityUpdates");
    expect(second.useCommunityUpdates.getState().mode).toBe("custom");
  });
});

const desktopState = (patch: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.2.1",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...patch,
});

function fakeBridge(initial: DesktopUpdateState, steps: { check?: DesktopUpdateState } = {}) {
  let state = initial;
  const listeners = new Set<(next: DesktopUpdateState) => void>();
  const calls: string[] = [];
  const publish = (next: DesktopUpdateState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const bridge = {
    getUpdateState: vi.fn(async () => state),
    checkForUpdate: vi.fn(async () => {
      calls.push("check");
      if (steps.check) state = steps.check;
      return { checked: true, state };
    }),
    downloadUpdate: vi.fn(async () => {
      calls.push("download");
      const downloading = { ...state, status: "downloading" as const, downloadPercent: 10 };
      state = downloading;
      // Progress and completion arrive as state events after the call returns.
      setTimeout(() => publish({ ...downloading, downloadPercent: 60 }), 0);
      setTimeout(
        () =>
          publish({
            ...downloading,
            status: "downloaded",
            downloadPercent: 100,
            downloadedVersion: downloading.availableVersion,
          }),
        5,
      );
      return { accepted: true, completed: false, state: downloading };
    }),
    installUpdate: vi.fn(async (version?: string) => {
      calls.push(`install ${version}`);
      return { accepted: true, completed: false, state };
    }),
    onUpdateState: vi.fn((listener: (next: DesktopUpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return { bridge, calls };
}

describe("one-click update and restart", () => {
  it("only offers itself when the desktop runs the Stardust updater", () => {
    expect(desktopCanSelfUpdate(null)).toBe(false);
    expect(desktopCanSelfUpdate(desktopState({ enabled: false, status: "disabled" }))).toBe(false);
    expect(desktopCanSelfUpdate(desktopState())).toBe(true);
    expect(
      communityInstallPhase(desktopState({ status: "available", availableVersion: "1.2.2" })),
    ).toBe("ready");
    expect(communityInstallPhase(desktopState({ status: "downloading" }))).toBe("downloading");
    expect(
      communityInstallPhase(desktopState({ status: "downloaded", downloadedVersion: "1.2.2" })),
    ).toBe("downloaded");
  });

  it("checks, downloads, waits for verification and installs the new version", async () => {
    const { bridge, calls } = fakeBridge(desktopState(), {
      check: desktopState({ status: "available", availableVersion: "1.2.2" }),
    });
    await expect(runCommunityUpdateAndRestart(bridge)).resolves.toEqual({
      ok: true,
      version: "1.2.2",
    });
    expect(calls).toEqual(["check", "download", "install 1.2.2"]);
  });

  it("installs an already downloaded update without downloading again", async () => {
    const { bridge, calls } = fakeBridge(
      desktopState({ status: "downloaded", availableVersion: "1.2.2", downloadedVersion: "1.2.2" }),
    );
    await expect(runCommunityUpdateAndRestart(bridge)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual(["install 1.2.2"]);
  });

  it("reports the updater's reason instead of installing", async () => {
    const { bridge, calls } = fakeBridge(desktopState(), {
      check: desktopState({
        status: "error",
        message: "GitHub is rate-limiting update checks. Try again later.",
      }),
    });
    await expect(runCommunityUpdateAndRestart(bridge)).resolves.toEqual({
      ok: false,
      message: "GitHub is rate-limiting update checks. Try again later.",
    });
    expect(calls).toEqual(["check"]);

    const disabled = fakeBridge(
      desktopState({ enabled: false, status: "disabled", message: "off" }),
    );
    await expect(runCommunityUpdateAndRestart(disabled.bridge)).resolves.toEqual({
      ok: false,
      message: "off",
    });
    expect(disabled.calls).toEqual([]);
  });
});

describe("automatic install preference", () => {
  it("is off by default and persists once turned on", async () => {
    const first = await import("./communityUpdates");
    expect(first.useCommunityUpdates.getState().autoInstall).toBe(false);
    first.useCommunityUpdates.getState().setAutoInstall(true);
    vi.resetModules();
    const second = await import("./communityUpdates");
    expect(second.useCommunityUpdates.getState().autoInstall).toBe(true);
  });
});
