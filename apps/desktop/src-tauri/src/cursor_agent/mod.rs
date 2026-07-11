//! Cursor CLI agent integration: ACP primary path + stream-json fallback.

mod acp_client;
pub mod setup;
mod stream_adapter;
pub mod stream_spawn;

pub use acp_client::cleanup_all_acp_sessions;
