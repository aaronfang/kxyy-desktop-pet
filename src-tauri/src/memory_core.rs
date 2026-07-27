//! Provider-neutral contract for memory consolidation.
//!
//! The memory domain owns this small interface instead of depending on a
//! particular model, HTTP client, Tauri state, or provider-specific settings.
//! Adapters (DeepSeek/Ollama today, other providers later) implement it in
//! their integration module.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCompletionRequest {
    pub system: String,
    pub input: String,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCompletionResult {
    pub json: String,
    pub provider: String,
    pub elapsed_ms: u128,
}

#[derive(Debug)]
pub enum MemoryProviderError {
    Unavailable(String),
    Request(String),
    InvalidOutput(String),
}

impl std::fmt::Display for MemoryProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(v) => write!(f, "provider unavailable: {v}"),
            Self::Request(v) => write!(f, "provider request failed: {v}"),
            Self::InvalidOutput(v) => write!(f, "provider returned invalid output: {v}"),
        }
    }
}

impl std::error::Error for MemoryProviderError {}

pub trait MemoryCompletionProvider: Send + Sync {
    fn complete_memory_batch(
        &self,
        request: MemoryCompletionRequest,
    ) -> Result<MemoryCompletionResult, MemoryProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Mock;
    impl MemoryCompletionProvider for Mock {
        fn complete_memory_batch(
            &self,
            request: MemoryCompletionRequest,
        ) -> Result<MemoryCompletionResult, MemoryProviderError> {
            Ok(MemoryCompletionResult {
                json: request.input,
                provider: "mock".into(),
                elapsed_ms: 0,
            })
        }
    }

    #[test]
    fn contract_is_provider_neutral_and_mockable() {
        let provider = Mock;
        let result = provider
            .complete_memory_batch(MemoryCompletionRequest {
                system: "system".into(),
                input: "{}".into(),
                max_output_tokens: Some(100),
            })
            .unwrap();
        assert_eq!(result.json, "{}");
        assert_eq!(result.provider, "mock");
    }
}
