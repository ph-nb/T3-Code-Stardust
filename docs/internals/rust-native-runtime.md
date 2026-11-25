# Rust runtime and native desktop boundary

The target is a Rust runtime for T3-owned backend behavior and a Tauri 2 desktop host. React remains the web and desktop renderer; React Native remains the mobile client. The desktop and standalone server share the same Rust domain and persistence code. Provider CLIs remain external programs with their own dependencies and authentication.

The migration must preserve environment identity, the current client protocol, retained projections, command receipts, process recovery and checkpoint behavior. The existing event log is pruned, so replaying it alone cannot migrate the complete database. PostgreSQL remains the Linux server's durable authority, Redis remains disposable, and filesystem assets and encrypted credentials stay bound to their owning environment. Local desktop mode must retain an embedded database through a Rust driver so installing the desktop app does not require operating PostgreSQL; storage adapters share the same domain behavior.

## Runtime structure

`native/stardust` is an independent Cargo workspace. The runtime library contains storage, authentication admission and transport code; the standalone binary owns configuration and process lifetime. The Tauri binary owns native windows and invokes the same runtime library when embedded hosting is enabled. It must not spawn the TypeScript server to claim a Rust migration.

Use Tokio for asynchronous execution, Axum for HTTP and WebSocket transport, SQLx for PostgreSQL, redis-rs for cache access and Tauri 2 for platform webviews. Keep orchestration decisions independent of I/O, and execute provider, Git and filesystem effects only after intent commits. A modular process is sufficient for a single environment; these crate boundaries do not require microservices.

The Node server remains the complete operational implementation until parity is demonstrated. The PostgreSQL Rust preview only admits loopback connections and schemas prefixed `stardust_rust_`; it reports `clientProtocolCompatible: false`. The desktop's local mode now implements the retained protocol for admission, projects, threads and Codex execution, with its own SQLite projections and command receipts. It starts with a separate data directory, not an in-place import of shipping state. Unsupported RPCs fail explicitly. A successful health check or native window build does not establish full feature parity.

The local desktop keeps renderer assets on the native app origin. Its in-memory credential is injected only into the top-level bundled document and is never served by the HTTP listener. Frontend code accepts that bootstrap only on the native origin and only for a loopback API target. Cookie admission remains separate, single-use bootstrap credentials expire, and WebSocket tickets are short-lived and consumed once. This avoids attaching native authority to navigated pages or workspace previews while preserving one authenticated primary environment across the existing client runtime.

## Protocol and data compatibility

Effect RPC is a wire protocol, including request IDs, streaming chunks, acknowledgements, interrupts, errors and frame splitting. Rust must implement and test its encoded forms against the retained client runtime. Replacing `/ws` with a generic JSON-RPC endpoint would break clients even if method names match. Keep version negotiation, flow control, subscription teardown, session renewal and reconnect cursors within the acceptance boundary.

The initial SQL baseline is exported from the shipping PostgreSQL schema rather than independently reconstructing 48 tables. A project commit acquires the write-order lock before receipt/version reads, then commits its event, projection and receipt together. The existing environment owner lock is shared with the Node runtime. Cache availability never grants access or becomes a unique copy of accepted work.

Desktop migration includes every `DesktopBridge` capability, not only opening the existing renderer in a webview: WSL and SSH, menus and keybindings, keychain, notifications, capture permissions, browser automation, file drag, updater verification, deep links and lifecycle cleanup. Tauri does not provide Electron's `<webview>` behavior. Browser and device tools need a native host implementation and their own process ownership; unsupported capabilities must remain explicit rather than returning success.

Provider SDK dependencies are a separate migration boundary. A provider may expose a CLI, ACP, app-server protocol or only an SDK. Each driver needs a native protocol implementation and recorded-turn compatibility checks. Temporary SDK subprocess adapters must be labeled as such; they do not satisfy completion of the Rust backend.

## Completion boundary

Retire the Node/Electron paths only when current web, desktop and mobile clients complete pairing, project/thread operations, a free replay turn, cancellation, approvals, terminal I/O, checkpoint restore, scheduled work, process-loss recovery and remote reconnection against Rust. Verify PostgreSQL import/restore, ownership loss, Redis outage, cursor ordering, authorization and signed updates on supported architectures. Keep working data and the previous deployment recoverable until that boundary is met.
