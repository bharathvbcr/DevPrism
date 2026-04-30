use lazy_static::lazy_static;
use regex::Regex;

lazy_static! {
    static ref SECRET_PATTERNS: Vec<(&'static str, Regex)> = vec![
        ("AWS Key", Regex::new(r"AKIA[0-9A-Z]{16}").unwrap()),
        (
            "Google API Key",
            Regex::new(r"AIza[0-9A-Za-z-_]{35}").unwrap()
        ),
        (
            "Anthropic Key",
            Regex::new(r"sk-ant-api03-[0-9A-Za-z-_]{93}").unwrap()
        ),
        (
            "Bearer Token",
            Regex::new(r"Bearer\s+[a-zA-Z0-9\-\._~\+\/]+=*").unwrap()
        ),
        (
            "Generic Secret",
            Regex::new(r"(?i)(password|secret|key|passwd|token)\s*[:=]\s*[^\s]{8,}").unwrap()
        ),
        (
            "Email",
            Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap()
        ),
    ];
}

pub struct Redactor;

impl Redactor {
    pub fn redact(text: &str) -> String {
        let mut redacted = text.to_string();
        for (label, pattern) in SECRET_PATTERNS.iter() {
            redacted = pattern
                .replace_all(&redacted, |_caps: &regex::Captures| {
                    format!("[REDACTED {}]", label)
                })
                .to_string();
        }
        redacted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redaction() {
        let input = "My AWS key is AKIA1234567890ABCDEF and my email is test@example.com. Password: mysecretpassword123";
        let output = Redactor::redact(input);
        assert!(output.contains("[REDACTED AWS Key]"));
        assert!(output.contains("[REDACTED Email]"));
        assert!(output.contains("[REDACTED Generic Secret]"));
        assert!(!output.contains("AKIA1234567890ABCDEF"));
        assert!(!output.contains("test@example.com"));
    }
}
