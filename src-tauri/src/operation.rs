//! Provider-neutral operation contracts shared by long-running desktop work.

use serde::{Deserialize, Serialize};

/// Stable categories used by the frontend to choose a recovery action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationErrorKind {
    InvalidInput,
    PermissionDenied,
    NotFound,
    TemporarilyUnavailable,
    Timeout,
    Cancelled,
    Internal,
}

/// A safe, structured operation failure. `message` is user-facing and must
/// never contain credentials, URLs, local paths, raw provider errors, or text
/// payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub kind: OperationErrorKind,
    pub retryable: bool,
    pub user_action: Option<String>,
    pub operation_id: String,
    pub message: String,
}

/// A deterministic identifier for retrying a side-effecting operation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(namespace: &str, stable_input: &str) -> Option<Self> {
        let namespace = sanitize_component(namespace, 32)?;
        let input = sanitize_component(stable_input, 160)?;
        Some(Self(format!("{namespace}:{input}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn sanitize_component(value: &str, max_len: usize) -> Option<String> {
    let normalized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
        .take(max_len)
        .collect::<String>();
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_key_is_stable_and_excludes_unsafe_characters() {
        let first = IdempotencyKey::new("memory job", "episode/1?secret=key")
            .expect("sanitized key");
        let second = IdempotencyKey::new("memory job", "episode/1?secret=key")
            .expect("sanitized key");
        assert_eq!(first, second);
        assert_eq!(first.as_str(), "memoryjob:episode1secretkey");
    }

    #[test]
    fn empty_idempotency_components_are_rejected() {
        assert!(IdempotencyKey::new("///", "value").is_none());
        assert!(IdempotencyKey::new("namespace", "").is_none());
    }

    #[test]
    fn structured_error_serializes_to_stable_frontend_shape() {
        let error = OperationError {
            kind: OperationErrorKind::Timeout,
            retryable: true,
            user_action: Some("retry".into()),
            operation_id: "op-1".into(),
            message: "请求超时".into(),
        };
        let json = serde_json::to_value(error).expect("serializable");
        assert_eq!(json["kind"], "timeout");
        assert_eq!(json["retryable"], true);
        assert_eq!(json["userAction"], "retry");
        assert_eq!(json["operationId"], "op-1");
    }
}
