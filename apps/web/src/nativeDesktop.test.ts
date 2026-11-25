import { expect, it, vi } from "vite-plus/test";
import { parseNativeDesktopBootstrap } from "./nativeDesktop";
import { readPrimaryEnvironmentTarget } from "./environments/primary/target";
import { readDesktopPrimaryBearerToken } from "./environments/primary/desktopAuth";
import { isHostedStaticApp } from "./hostedPairing";

it("admits a native local credential only on the bundled page and only for a loopback backend", () => {
  const bootstrap = {
    environmentId: "environment",
    httpBaseUrl: "http://127.0.0.1:12345",
    bearerToken: "a".repeat(64),
  };
  for (const page of ["http://tauri.localhost", "tauri://localhost"]) {
    expect(parseNativeDesktopBootstrap(bootstrap, new URL(page))).toEqual({
      ...bootstrap,
      httpBaseUrl: bootstrap.httpBaseUrl + "/",
    });
  }
  for (const page of [
    "https://untrusted.example",
    "http://localhost:12345",
    "https://tauri.localhost.example",
    "blob:http://tauri.localhost/untrusted-preview",
  ]) {
    expect(parseNativeDesktopBootstrap(bootstrap, new URL(page))).toBeNull();
  }
  for (const httpBaseUrl of [
    "https://untrusted.example",
    "http://127.0.0.1:12345@untrusted.example",
    "http://127.0.0.1:12345/path",
    "http://127.0.0.1:12345?token=x",
  ]) {
    expect(
      parseNativeDesktopBootstrap({ ...bootstrap, httpBaseUrl }, new URL("http://tauri.localhost")),
    ).toBeNull();
  }
  expect(
    parseNativeDesktopBootstrap(
      { ...bootstrap, bearerToken: "invalid" },
      new URL("http://tauri.localhost"),
    ),
  ).toBeNull();
});

it("connects the bundled renderer to the local authenticated HTTP and RPC endpoints", async () => {
  const bootstrap = {
    environmentId: "environment",
    httpBaseUrl: "http://127.0.0.1:12345/",
    bearerToken: "b".repeat(64),
  };
  vi.stubGlobal("window", {
    location: new URL("http://tauri.localhost/"),
    __STARDUST_NATIVE__: bootstrap,
  });
  try {
    expect(isHostedStaticApp()).toBe(false);
    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "desktop-managed",
      target: { httpBaseUrl: bootstrap.httpBaseUrl, wsBaseUrl: "ws://127.0.0.1:12345/" },
    });
    expect(await readDesktopPrimaryBearerToken()).toBe(bootstrap.bearerToken);
  } finally {
    vi.unstubAllGlobals();
  }
});
