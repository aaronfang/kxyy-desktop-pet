//! Bounded semantic text delivery, independent of generation and transport.
#[derive(Default)]
pub struct TextDelivery {
    pub parts: Vec<String>,
    pub confirmed: usize,
    awaiting: bool,
}
impl TextDelivery {
    pub fn with_details(summary: &str, details: &str) -> Self {
        let mut delivery = Self::new(summary, false);
        let mut rest: Vec<char> = details.chars().take(5500).collect();
        for slot in 0..3 {
            if rest.is_empty() {
                break;
            }
            let max = rest.len().min(2000);
            let min = rest
                .len()
                .saturating_sub((2 - slot) * 2000)
                .max(max.saturating_sub(700));
            let end = if max == rest.len() {
                max
            } else {
                (min..max).rev().find(|&i| rest[i] == '\n').unwrap_or(max)
            };
            delivery
                .parts
                .push(rest.drain(..end).collect::<String>().trim().to_string());
            while rest.first() == Some(&'\n') {
                rest.remove(0);
            }
        }
        delivery
    }
    pub fn new(text: &str, split: bool) -> Self {
        let mut parts: Vec<String> = if split {
            text.split('\n')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        } else {
            vec![text.into()]
        };
        if parts.len() > 3 {
            let tail = parts.drain(2..).collect::<Vec<_>>().join("\n\n");
            parts.push(tail);
        }
        Self {
            parts,
            confirmed: 0,
            awaiting: true,
        }
    }
    pub fn acknowledge(&mut self, outcome: &str) {
        if !self.awaiting {
            return;
        }
        self.awaiting = false;
        if outcome == "sent" && self.confirmed < self.parts.len() {
            self.confirmed += 1;
        }
    }
    pub fn begin_next(&mut self) {
        self.awaiting = true;
    }
    pub fn delivered(&self) -> String {
        self.parts[..self.confirmed].join("\n\n")
    }
    pub fn next(&self) -> Option<&str> {
        self.parts.get(self.confirmed).map(String::as_str)
    }
    pub fn outcome(&self, last: &str) -> String {
        if self.confirmed == self.parts.len() {
            "sent".into()
        } else if self.confirmed > 0 {
            "partial".into()
        } else {
            last.into()
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn research_is_one_ordered_delivery_with_bounded_text_after_the_summary() {
        let details = format!("第一来源 https://example.com/a\n\n{}", "资料".repeat(2700));
        let mut d = TextDelivery::with_details("语音概括", &details);
        assert_eq!(d.next(), Some("语音概括"));
        assert!(d.parts.len() <= 4);
        assert!(d.parts.iter().all(|p| p.chars().count() <= 2000));
        d.acknowledge("unknown");
        assert_eq!(d.delivered(), "");
        assert_eq!(d.outcome("unknown"), "unknown");
        let mut d = TextDelivery::with_details("语音概括", "来源 https://example.com/a");
        d.acknowledge("sent");
        d.acknowledge("sent");
        assert_eq!(d.delivered(), "语音概括");
        d.begin_next();
        d.acknowledge("failed");
        assert_eq!(d.outcome("failed"), "partial");
        assert!(!d.delivered().contains("https:"));
    }
    #[test]
    fn partial_receipt_never_claims_unsent_text_and_split_is_bounded() {
        let mut d = TextDelivery::new("第一条\n\n第二条\n\n第三条\n\n第四条", true);
        assert_eq!(TextDelivery::new("第一段。\n第二段。", true).parts.len(), 2);
        assert_eq!(d.parts.len(), 3);
        d.acknowledge("sent");
        d.acknowledge("unknown");
        assert_eq!(d.delivered(), "第一条");
        assert_eq!(d.outcome("unknown"), "partial");
        assert_eq!(d.next(), Some("第二条"));
        assert_eq!(TextDelivery::new("一\n\n二", false).parts.len(), 1);
    }
    #[test]
    fn duplicate_receipts_cannot_confirm_an_unsent_following_part() {
        let mut d = TextDelivery::new("一\n\n二", true);
        d.acknowledge("sent");
        d.acknowledge("sent");
        assert_eq!(d.delivered(), "一");
    }
}
