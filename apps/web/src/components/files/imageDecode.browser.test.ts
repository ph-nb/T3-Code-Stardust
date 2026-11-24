import { expect, it } from "vite-plus/test";
import workerUrl from "./imageDecode.worker.ts?worker&url";
import photoUrl from "../../../test/fixtures/images/photo.heic?url";
import wasmUrl from "../../terminal/ghostty/vendor/ghostty-vt.wasm?url";
import nativeDesktopConfig from "../../../../../native/stardust/crates/desktop/tauri.conf.json";

it.each([
  ["Electron", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:"],
  ["Rust", nativeDesktopConfig.app.security.csp],
])("decodes HEIC under the %s desktop content security policy", async (_desktop, policy) => {
  const bytes = await (await fetch(photoUrl)).arrayBuffer();
  const directives = policy.split(";").map((directive) => directive.trim());
  const scriptSources =
    directives.find((directive) => directive.startsWith("script-src "))?.slice(11) ??
    directives.find((directive) => directive.startsWith("default-src "))?.slice(12) ??
    "";
  // Permit only the test bootstrap; compilation still follows the desktop's script sources.
  const framePolicy = [
    ...directives.filter((directive) => !directive.startsWith("script-src ")),
    `script-src ${scriptSources} 'nonce-desktop-csp-test'`,
  ].join("; ");
  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${framePolicy}"><script nonce="desktop-csp-test">
    onmessage = async ({ data }) => {
      try {
        new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        await WebAssembly.compile(await (await fetch(data.wasmUrl)).arrayBuffer());
        let javascriptEvalBlocked = false;
        try { Function('return 1')(); } catch { javascriptEvalBlocked = true; }
        const url = URL.createObjectURL(new Blob(['import ' + JSON.stringify(data.workerUrl)], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        worker.onmessage = ({ data }) => {
          parent.postMessage({ ...data, javascriptEvalBlocked }, '*');
          worker.terminate();
          URL.revokeObjectURL(url);
        };
        worker.onerror = (event) => parent.postMessage({ error: event.message }, '*');
        worker.postMessage({ bytes: data.bytes, heif: true }, [data.bytes]);
      } catch (error) {
        parent.postMessage({ error: error.message }, '*');
      }
    };
  </script>`;
  const controller = new AbortController();
  try {
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("load", () => resolve(), { once: true }),
    );
    document.body.append(frame);
    await loaded;
    const decoded = new Promise<{ blob?: Blob; error?: string; javascriptEvalBlocked?: boolean }>(
      (resolve) => {
        window.addEventListener(
          "message",
          (event) => {
            if (event.source === frame.contentWindow) resolve(event.data);
          },
          { signal: controller.signal },
        );
      },
    );
    frame.contentWindow!.postMessage(
      {
        bytes,
        workerUrl: new URL(workerUrl, location.href).href,
        wasmUrl: new URL(wasmUrl, location.href).href,
      },
      "*",
      [bytes],
    );
    const result = await decoded;
    expect(result.error).toBeUndefined();
    expect(result.javascriptEvalBlocked).toBe(true);
    expect(result.blob?.type).toBe("image/png");
    const bitmap = await createImageBitmap(result.blob!);
    expect([bitmap.width, bitmap.height]).toEqual([128, 128]);
    bitmap.close();
  } finally {
    controller.abort();
    frame.remove();
  }
});
