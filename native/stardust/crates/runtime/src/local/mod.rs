mod auth;
mod domain;
mod process;
mod provider;
#[cfg(test)]
mod recovery_tests;
mod requests;
mod rpc;
mod server;
mod store;

pub use server::{AssetLoader, LocalAsset, LocalServer};
pub use store::LocalStore;

use serde_json::Value;
use std::sync::LazyLock;

pub(super) static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../schema/local-client-defaults.json"
    ))
    .expect("generated local contracts")
});

pub(super) fn now() -> String {
    // SQLite uses the same UTC wire format as the retained clients.
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("UTC timestamp")
}

pub(super) fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
