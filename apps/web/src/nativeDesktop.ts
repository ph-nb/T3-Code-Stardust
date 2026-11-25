export interface NativeDesktopBootstrap {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

export function parseNativeDesktopBootstrap(
  value: unknown,
  page: URL,
): NativeDesktopBootstrap | null {
  const trustedPage =
    (page.protocol === "http:" && page.host === "tauri.localhost") ||
    (page.protocol === "tauri:" && page.host === "localhost");
  if (!trustedPage || value === null || typeof value !== "object") return null;
  if (
    !("environmentId" in value) ||
    typeof value.environmentId !== "string" ||
    !value.environmentId.trim() ||
    !("httpBaseUrl" in value) ||
    typeof value.httpBaseUrl !== "string" ||
    !("bearerToken" in value) ||
    typeof value.bearerToken !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.bearerToken)
  )
    return null;
  try {
    const target = new URL(value.httpBaseUrl);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !target.port ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    )
      return null;
    return {
      environmentId: value.environmentId,
      httpBaseUrl: target.toString(),
      bearerToken: value.bearerToken,
    };
  } catch {
    return null;
  }
}

export function readNativeDesktopBootstrap(): NativeDesktopBootstrap | null {
  if (typeof window === "undefined" || !window.location) return null;
  const value = Reflect.get(window, "__STARDUST_NATIVE__");
  if (value === undefined) return null;
  try {
    return parseNativeDesktopBootstrap(value, new URL(window.location.href));
  } catch {
    return null;
  }
}
