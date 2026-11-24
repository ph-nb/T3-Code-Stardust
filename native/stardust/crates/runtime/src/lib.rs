pub mod api;
pub mod config;
pub mod protocol;
pub mod storage;

pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ORCHESTRATION_PROTOCOL: u32 = 2;
