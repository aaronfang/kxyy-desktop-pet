//! Stable task-to-capability routing vocabulary.
//! The router is deliberately advisory for now; callers may continue using
//! their existing provider selection until a later migration phase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskKind {
    TextChat,
    Vision,
    RealtimeVoice,
    MemoryConsolidation,
    FreshTopics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteTarget {
    Deepseek,
    Ollama,
    LocalVoice,
    Volcano,
    LocalCache,
    Disabled,
}

pub fn route(task: TaskKind, provider: &str, voice_backend: &str, enabled: bool) -> RouteTarget {
    let provider = provider.trim().to_ascii_lowercase();
    let voice_backend = voice_backend.trim().to_ascii_lowercase();
    match task {
        TaskKind::TextChat | TaskKind::Vision => match provider.as_str() {
            "local" => RouteTarget::Ollama,
            "deepseek" | "" => RouteTarget::Deepseek,
            _ => RouteTarget::Disabled,
        },
        TaskKind::RealtimeVoice => match voice_backend.as_str() {
            "volc" => RouteTarget::Volcano,
            "local" | "voxcpm" | "voxcpm2" | "cosyvoice" | "cosy" => RouteTarget::LocalVoice,
            _ => RouteTarget::Disabled,
        },
        TaskKind::MemoryConsolidation => {
            if enabled { RouteTarget::Ollama } else { RouteTarget::Disabled }
        }
        TaskKind::FreshTopics => {
            if enabled { RouteTarget::LocalCache } else { RouteTarget::Disabled }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_values_fail_closed() {
        assert_eq!(route(TaskKind::TextChat, "mystery", "", true), RouteTarget::Disabled);
        assert_eq!(route(TaskKind::RealtimeVoice, "", "mystery", true), RouteTarget::Disabled);
    }

    #[test]
    fn existing_provider_contracts_are_mapped() {
        assert_eq!(route(TaskKind::TextChat, "deepseek", "", true), RouteTarget::Deepseek);
        assert_eq!(route(TaskKind::TextChat, "local", "", true), RouteTarget::Ollama);
        assert_eq!(route(TaskKind::RealtimeVoice, "", "cosy", true), RouteTarget::LocalVoice);
        assert_eq!(route(TaskKind::RealtimeVoice, "", "cosyvoice", true), RouteTarget::LocalVoice);
        assert_eq!(route(TaskKind::FreshTopics, "", "", false), RouteTarget::Disabled);
    }
}
