pub mod api;
pub mod config;
#[cfg(feature = "desktop")]
pub mod local;
pub mod protocol;
pub mod storage;

pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ORCHESTRATION_PROTOCOL: u32 = 2;
