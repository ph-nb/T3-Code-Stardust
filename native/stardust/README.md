# Stardust native runtime preview

This Cargo workspace starts the Rust backend and Tauri 2 desktop migration. It is a preview, not a replacement for the complete shipping server. The existing React/React Native clients are not yet protocol compatible. Provider execution, PTY, Git/checkpoints, scheduling, scoped pairing and desktop bridge parity are not implemented here yet.

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

The desktop shell uses platform webviews through Tauri and does not start Electron. For a remote client, set `STARDUST_DESKTOP_URL` to an HTTPS frontend, or loopback HTTP. For an embedded native preview, provide `STARDUST_STATE_DIR`, `STARDUST_TOKEN_FILE`, `STARDUST_FRONTEND_DIR`, `T3CODE_DATABASE_URL` and optional `T3CODE_REDIS_URL`. The same Rust library owns the embedded server and shutdown. Full renderer/desktop bridge compatibility is still required before release.

```sh
cargo run --manifest-path native/stardust/Cargo.toml -p stardust-desktop
```

Regenerate the PostgreSQL baseline with `node apps/server/scripts/export-rust-schema.ts` and the client/desktop inventory with `node scripts/export-rust-contracts.ts`. Both exporters accept `--check`; the schema is derived from the existing PostgreSQL implementation at SQLite migration head 105. Architectural constraints are in [the native runtime decision](../../docs/internals/rust-native-runtime.md).
