pub mod gemini;
pub mod ollama;

use crate::agent::{Message, Response};
use async_trait::async_trait;
use futures::Stream;
use serde_json::Value;
use std::pin::Pin;

pub enum StreamUpdate {
    Delta(String),
    ToolUse(String, String, Value), // id, name, input
    Complete(Response),
}

#[async_trait]
pub trait Provider: Send + Sync {
    async fn chat(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<Value>>,
    ) -> Result<Response, String>;
    fn chat_stream(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<Value>>,
    ) -> Pin<Box<dyn Stream<Item = Result<StreamUpdate, String>> + Send>>;
    #[allow(dead_code)]
    fn name(&self) -> &str;
}
