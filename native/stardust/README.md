# Stardust native runtime preview

This Cargo workspace contains the Rust backend and Tauri 2 desktop migration. The desktop local mode supports native admission, projects, threads, replay verification and Codex app-server turns. It remains a preview: other provider drivers, PTY, Git/checkpoints, scheduling, remote sharing, existing-data import and desktop bridge parity are still incomplete. The separate PostgreSQL server preview does not yet implement the complete client protocol.

The executable contains no Node runtime or TypeScript backend subprocess. It currently supports authenticated native project operations, atomic PostgreSQL event/projection/receipt writes, idempotent command handling, environment ownership, Redis cache primitives and the Effect RPC envelope. `/healthz` and `/api/native/v1/capabilities` report the compatibility boundary explicitly.

Use an isolated PostgreSQL and Redis instance. Preview schemas must start with `stardust_rust_`; listeners must use loopback. The supplied state directory must be isolated from a real T3 home. A bearer token file must contain at least 32 characters and should be readable only by its owner.

```sh
cargo test --manifest-path native/stardust/Cargo.toml --locked
export T3CODE_DATABASE_URL=postgresql://...
export T3CODE_REDIS_URL=redis://...
cargo run --manifest-path native/stardust/Cargo.toml -p stardust-server -- \
  --data-dir /path/to/isolated-state --token-file /path/to/protected-token
```

Native API requests use `Authorization: Bearer <token>`. Project creation uses `POST /api/native/v1/projects` with `commandId`, `projectId`, `title` and `workspaceRoot`; reads use `GET /api/native/v1/projects` and `GET /api/native/v1/events?after=0`. Duplicate command IDs return the original sequence. Conflicting writes roll back their event and receipt.

Real-service tests require `STARDUST_TEST_POSTGRES_URL` and `STARDUST_TEST_REDIS_URL`:

```sh
cargo test --manifest-path native/stardust/Cargo.toml -p stardust-runtime --features integration --locked
```

The desktop shell uses platform webviews through Tauri. A normal launch starts the local Rust runtime automatically, keeps the Chinese React client on the bundled asset origin and admits it with an in-memory desktop credential. The local database and webview profile live in the app's own local data directory under `local-runtime-v1`; they do not reuse a shipping T3 home. Local mode requires no PostgreSQL, Redis or Node backend. Codex runs through its installed native CLI and keeps ownership of its authentication; the app exposes provider login when needed. Provider processes on Windows belong to jobs that close with their native owner.

For a specific hosted frontend, set `STARDUST_DESKTOP_URL` to an HTTPS frontend, or loopback HTTP. For the original PostgreSQL native API preview, explicitly provide `STARDUST_STATE_DIR`, `STARDUST_TOKEN_FILE`, `STARDUST_FRONTEND_DIR`, `T3CODE_DATABASE_URL` and optional `T3CODE_REDIS_URL`. The same Rust library owns the embedded server and shutdown. Full renderer/desktop bridge compatibility is still required before release.

```sh
cargo run --manifest-path native/stardust/Cargo.toml -p stardust-desktop
```

Build `apps/web` first, then run `tauri build --ci --bundles nsis -- --locked` from `crates/desktop` with Tauri CLI 2.12.6. Windows installers use a separate per-user `Stardust Rust Preview` installation and application identity, with Chinese and English installer languages. WebView2 is required; the installer downloads its bootstrapper if the runtime is missing. Startup diagnostics are written to the app-specific log directory as `startup.log`, without server URLs or credentials (except the embedded loopback listener address).

Verify the local runtime with `cargo test --manifest-path native/stardust/Cargo.toml -p stardust-runtime --features desktop`. Build its isolated verification host with `cargo build --manifest-path native/stardust/Cargo.toml -p stardust-runtime --features desktop --bin stardust-local`, then run `node apps/server/scripts/prove-rust-local.ts <absolute-native-binary>`. The proof uses a disposable state directory, validates responses through the retained client schemas and exercises replay, deduplication and cancellation without a paid provider. An explicit `STARDUST_REAL_CODEX_MODEL` opts into one real file-writing turn in a separate temporary workspace; it is not used in CI.

Regenerate the PostgreSQL baseline with `node apps/server/scripts/export-rust-schema.ts` and the client/desktop inventory with `node scripts/export-rust-contracts.ts`. Both exporters accept `--check`; the schema is derived from the existing PostgreSQL implementation at SQLite migration head 105. Architectural constraints are in [the native runtime decision](../../docs/internals/rust-native-runtime.md).
