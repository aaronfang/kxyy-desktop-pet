//! Fixed capability vocabulary for diagnostics and settings surfaces.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityStatus {
    Disabled,
    Unsupported,
    NotInstalled,
    Starting,
    Ready,
    Busy,
    Faulted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub name: String,
    pub status: CapabilityStatus,
    pub contract_version: String,
    pub driver: String,
    pub fallback_reason: Option<String>,
}

pub fn with_reason(
    name: &str,
    status: CapabilityStatus,
    driver: &str,
    fallback_reason: Option<&str>,
) -> CapabilitySnapshot {
    let mut value = snapshot(name, status, driver);
    value.fallback_reason = fallback_reason.map(|reason| {
        reason
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .take(64)
            .collect()
    });
    value
}

pub fn snapshot(name: &str, status: CapabilityStatus, driver: &str) -> CapabilitySnapshot {
    CapabilitySnapshot {
        name: name.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-').take(32).collect(),
        status,
        contract_version: "v1".into(),
        driver: driver.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-').take(32).collect(),
        fallback_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_snapshot_is_fixed_and_redacts_paths() {
        let value = snapshot("local/text", CapabilityStatus::Ready, "/Users/me/model");
        assert_eq!(value.name, "localtext");
        assert_eq!(value.driver, "Usersmemodel");
        assert_eq!(value.contract_version, "v1");
    }

    #[test]
    fn capability_status_uses_stable_wire_names() {
        let json = serde_json::to_string(&snapshot("memory", CapabilityStatus::NotInstalled, "sqlite")).unwrap();
        assert!(json.contains("not-installed"));
        assert!(json.contains("contractVersion"));
    }
}
