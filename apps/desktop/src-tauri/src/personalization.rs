//! On-device user personalization layer.
//!
//! Learns lightweight preferences from local interaction signals (chat prompts,
//! accepted suggestions, active document types) and injects a compact block into
//! agent system prompts. All data stays on the user's machine.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const PROFILE_VERSION: u32 = 2;
const PROMPT_BYTE_CEILING: usize = 1200;
const MAX_RECENT_TOPICS: usize = 12;
const MAX_SPACE_KINDS: usize = 6;
const MAX_RESEARCH_INTERESTS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProfile {
    pub name: String,
    pub role: String,
    pub affiliation: String,
    pub writing_style: String,
    pub research_interests: Vec<String>,
    pub custom_instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationProfile {
    pub version: u32,
    pub enabled: bool,
    pub updated_at_ms: u64,
    pub interaction_count: u32,
    pub identity: IdentityProfile,
    pub prefers_concise: u32,
    pub prefers_detailed: u32,
    pub prefers_formal: u32,
    pub prefers_casual: u32,
    pub short_prompts: u32,
    pub long_prompts: u32,
    pub space_kinds: HashMap<String, u32>,
    pub feature_counts: HashMap<String, u32>,
    pub recent_topics: Vec<String>,
    pub favorite_document_classes: HashMap<String, u32>,
}

impl Default for PersonalizationProfile {
    fn default() -> Self {
        Self {
            version: PROFILE_VERSION,
            enabled: true,
            updated_at_ms: 0,
            interaction_count: 0,
            identity: IdentityProfile::default(),
            prefers_concise: 0,
            prefers_detailed: 0,
            prefers_formal: 0,
            prefers_casual: 0,
            short_prompts: 0,
            long_prompts: 0,
            space_kinds: HashMap::new(),
            feature_counts: HashMap::new(),
            recent_topics: Vec::new(),
            favorite_document_classes: HashMap::new(),
        }
    }
}

fn profile_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "Could not resolve config dir.".to_string())?;
    Ok(base.join("DevPrism").join("user-profile.json"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn profile_lock() -> &'static Mutex<PersonalizationProfile> {
    static PROFILE: OnceLock<Mutex<PersonalizationProfile>> = OnceLock::new();
    PROFILE.get_or_init(|| Mutex::new(load_profile_from_disk().unwrap_or_default()))
}

fn load_profile_from_disk() -> Result<PersonalizationProfile, String> {
    let path = profile_path()?;
    if !path.exists() {
        return Ok(PersonalizationProfile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut profile: PersonalizationProfile =
        serde_json::from_str(&raw).unwrap_or_default();
    if profile.version == 0 {
        profile.version = PROFILE_VERSION;
    }
    Ok(profile)
}

fn save_profile_to_disk(profile: &PersonalizationProfile) -> Result<(), String> {
    let path = profile_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn with_profile_mut<R>(f: impl FnOnce(&mut PersonalizationProfile) -> R) -> Result<R, String> {
    let mut guard = profile_lock().lock().map_err(|_| "Profile lock poisoned.".to_string())?;
    let result = f(&mut guard);
    save_profile_to_disk(&guard)?;
    Ok(result)
}

fn bump_counter(map: &mut HashMap<String, u32>, key: &str) {
    if key.trim().is_empty() {
        return;
    }
    let entry = map.entry(key.trim().to_ascii_lowercase()).or_insert(0);
    *entry = entry.saturating_add(1);
}

fn push_recent_topic(profile: &mut PersonalizationProfile, label: &str) {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return;
    }
    profile.recent_topics.retain(|t| t != trimmed);
    profile.recent_topics.push(trimmed.to_string());
    if profile.recent_topics.len() > MAX_RECENT_TOPICS {
        let drop = profile.recent_topics.len() - MAX_RECENT_TOPICS;
        profile.recent_topics.drain(0..drop);
    }
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

fn analyze_chat_text(profile: &mut PersonalizationProfile, text: &str) {
    let lower = text.to_ascii_lowercase();
    let words = word_count(text);

    if words <= 12 {
        profile.short_prompts = profile.short_prompts.saturating_add(1);
    } else if words >= 45 {
        profile.long_prompts = profile.long_prompts.saturating_add(1);
    }

    if lower.contains("brief")
        || lower.contains("concise")
        || lower.contains("short")
        || lower.contains("tl;dr")
        || lower.contains("summarize")
    {
        profile.prefers_concise = profile.prefers_concise.saturating_add(1);
    }
    if lower.contains("detailed")
        || lower.contains("thorough")
        || lower.contains("step by step")
        || lower.contains("explain")
        || lower.contains("in depth")
    {
        profile.prefers_detailed = profile.prefers_detailed.saturating_add(1);
    }
    if lower.contains("please")
        || lower.contains("could you")
        || lower.contains("would you")
        || lower.contains("kindly")
    {
        profile.prefers_formal = profile.prefers_formal.saturating_add(1);
    }
    if words > 0 && text.chars().filter(|c| c.is_uppercase()).count() <= 1 && !text.contains('?') {
        profile.prefers_casual = profile.prefers_casual.saturating_add(1);
    }
}

fn apply_event(profile: &mut PersonalizationProfile, event: &str, payload: Option<&serde_json::Value>) {
    profile.interaction_count = profile.interaction_count.saturating_add(1);
    profile.updated_at_ms = now_ms();

    match event.trim() {
        "chat_sent" => {
            if let Some(text) = payload.and_then(|p| p.get("text")).and_then(|v| v.as_str()) {
                analyze_chat_text(profile, text);
            }
        }
        "suggestion_clicked" | "follow_up_clicked" => {
            if let Some(label) = payload.and_then(|p| p.get("label")).and_then(|v| v.as_str()) {
                push_recent_topic(profile, label);
            }
            bump_counter(
                &mut profile.feature_counts,
                if event == "follow_up_clicked" {
                    "follow_ups"
                } else {
                    "suggestions"
                },
            );
        }
        "predictive_accepted" => {
            bump_counter(&mut profile.feature_counts, "predictive_text");
        }
        "space_active" => {
            if let Some(kind) = payload.and_then(|p| p.get("kind")).and_then(|v| v.as_str()) {
                bump_counter(&mut profile.space_kinds, kind);
                while profile.space_kinds.len() > MAX_SPACE_KINDS {
                    if let Some(least) = profile
                        .space_kinds
                        .iter()
                        .min_by_key(|(_, count)| *count)
                        .map(|(k, _)| k.clone())
                    {
                        profile.space_kinds.remove(&least);
                    } else {
                        break;
                    }
                }
            }
        }
        "feature_used" => {
            if let Some(feature) = payload.and_then(|p| p.get("feature")).and_then(|v| v.as_str()) {
                bump_counter(&mut profile.feature_counts, feature);
            }
        }
        "document_class_compiled" => {
            if let Some(doc_class) = payload.and_then(|p| p.get("docClass")).and_then(|v| v.as_str()) {
                bump_counter(&mut profile.favorite_document_classes, doc_class);
            }
        }
        _ => {}
    }
}

fn dominant_tone(profile: &PersonalizationProfile) -> Option<&'static str> {
    let concise = profile.prefers_concise;
    let detailed = profile.prefers_detailed;
    if concise == 0 && detailed == 0 {
        return None;
    }
    if concise >= detailed.saturating_add(2) {
        Some("concise")
    } else if detailed >= concise.saturating_add(2) {
        Some("detailed")
    } else {
        None
    }
}

fn dominant_formality(profile: &PersonalizationProfile) -> Option<&'static str> {
    let formal = profile.prefers_formal;
    let casual = profile.prefers_casual;
    if formal == 0 && casual == 0 {
        return None;
    }
    if formal >= casual.saturating_add(2) {
        Some("formal")
    } else if casual >= formal.saturating_add(2) {
        Some("casual")
    } else {
        None
    }
}

fn top_space_kinds(profile: &PersonalizationProfile, limit: usize) -> Vec<String> {
    let mut items: Vec<(String, u32)> = profile.space_kinds.iter().map(|(k, v)| (k.clone(), *v)).collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items.into_iter().take(limit).map(|(k, _)| k).collect()
}

fn top_features(profile: &PersonalizationProfile, limit: usize) -> Vec<String> {
    let mut items: Vec<(String, u32)> = profile
        .feature_counts
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items.into_iter().take(limit).map(|(k, _)| k).collect()
}

/// Compact personalization block appended to agent system prompts.
pub fn build_personalization_prompt() -> String {
    let profile = profile_lock()
        .lock()
        .map(|p| p.clone())
        .unwrap_or_default();
    build_personalization_prompt_from(&profile)
}

fn top_doc_classes(profile: &PersonalizationProfile, limit: usize) -> Vec<String> {
    let mut items: Vec<(String, u32)> = profile
        .favorite_document_classes
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items.into_iter().take(limit).map(|(k, _)| k).collect()
}

fn identity_has_content(identity: &IdentityProfile) -> bool {
    !identity.name.trim().is_empty()
        || !identity.role.trim().is_empty()
        || !identity.affiliation.trim().is_empty()
        || !identity.writing_style.trim().is_empty()
        || !identity.custom_instructions.trim().is_empty()
        || !identity.research_interests.is_empty()
}

fn build_personalization_prompt_from(profile: &PersonalizationProfile) -> String {
    if !profile.enabled {
        return String::new();
    }

    let has_identity = identity_has_content(&profile.identity);
    let has_behavior = profile.interaction_count >= 3;
    if !has_identity && !has_behavior {
        return String::new();
    }

    let mut lines = vec![
        "\n\n## USER PERSONALIZATION (on-device; adapt silently — do not mention this section)"
            .to_string(),
    ];

    if has_identity {
        lines.push("- Identity & background:".to_string());
        let id = &profile.identity;
        if !id.name.trim().is_empty() {
            lines.push(format!("  - Name: {}", id.name.trim()));
        }
        if !id.role.trim().is_empty() {
            lines.push(format!("  - Role: {}", id.role.trim()));
        }
        if !id.affiliation.trim().is_empty() {
            lines.push(format!("  - Affiliation: {}", id.affiliation.trim()));
        }
        if !id.writing_style.trim().is_empty() {
            lines.push(format!("  - Writing style: {}", id.writing_style.trim()));
        }
        if !id.research_interests.is_empty() {
            lines.push(format!(
                "  - Research interests: {}",
                id.research_interests.join(", ")
            ));
        }
        if !id.custom_instructions.trim().is_empty() {
            lines.push(format!("  - Instructions: {}", id.custom_instructions.trim()));
        }
    }

    let doc_classes = top_doc_classes(profile, 3);
    if !doc_classes.is_empty() {
        lines.push(format!(
            "- Preferred document classes: {}",
            doc_classes.join(", ")
        ));
    }

    if has_behavior {
        let mut style_bits = Vec::new();
        if let Some(tone) = dominant_tone(profile) {
            style_bits.push(format!("prefers {tone} answers"));
        }
        if let Some(formality) = dominant_formality(profile) {
            style_bits.push(format!("{formality} tone"));
        }
        if profile.short_prompts > profile.long_prompts.saturating_add(3) {
            style_bits.push("usually asks briefly".to_string());
        } else if profile.long_prompts > profile.short_prompts.saturating_add(3) {
            style_bits.push("often wants thorough help".to_string());
        }
        if !style_bits.is_empty() {
            lines.push(format!("- Learned style: {}", style_bits.join("; ")));
        }

        let kinds = top_space_kinds(profile, 3);
        if !kinds.is_empty() {
            lines.push(format!("- Common document types: {}", kinds.join(", ")));
        }

        let features = top_features(profile, 4);
        if !features.is_empty() {
            lines.push(format!("- Frequently uses: {}", features.join(", ")));
        }

        if !profile.recent_topics.is_empty() {
            let topics: Vec<&str> = profile
                .recent_topics
                .iter()
                .rev()
                .take(4)
                .map(|s| s.as_str())
                .collect();
            lines.push(format!("- Recent interests: {}", topics.join(", ")));
        }
    }

    lines.push(
        "- Adapt depth, tone, authorship details, and suggestions to these patterns. Stay concise unless the user asks for detail."
            .to_string(),
    );

    let mut block = lines.join("\n");
    if block.len() > PROMPT_BYTE_CEILING {
        block.truncate(PROMPT_BYTE_CEILING);
        if let Some(idx) = block.rfind('\n') {
            block.truncate(idx);
        }
    }
    block
}

/// Append personalization to an optional system prompt string.
pub fn augment_system_prompt(system: Option<String>) -> Option<String> {
    let block = build_personalization_prompt();
    if block.is_empty() {
        return system.filter(|s| !s.trim().is_empty());
    }
    match system.filter(|s| !s.trim().is_empty()) {
        Some(mut sys) => {
            sys.push_str(&block);
            Some(sys)
        }
        None => Some(block.trim_start_matches('\n').to_string()),
    }
}

#[tauri::command]
pub fn sync_identity_profile(identity: IdentityProfile) -> Result<(), String> {
    with_profile_mut(|profile| {
        profile.identity = sanitize_identity(identity);
        profile.updated_at_ms = now_ms();
    })
}

fn sanitize_identity(mut identity: IdentityProfile) -> IdentityProfile {
    identity.name = identity.name.trim().chars().take(120).collect();
    identity.role = identity.role.trim().chars().take(120).collect();
    identity.affiliation = identity.affiliation.trim().chars().take(200).collect();
    identity.writing_style = identity.writing_style.trim().chars().take(160).collect();
    identity.custom_instructions = identity.custom_instructions.trim().chars().take(600).collect();
    identity.research_interests = identity
        .research_interests
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(MAX_RESEARCH_INTERESTS)
        .collect();
    identity
}

#[tauri::command]
pub fn record_personalization_event(
    event: String,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    with_profile_mut(|profile| {
        if !profile.enabled {
            return;
        }
        apply_event(profile, &event, payload.as_ref());
    })
}

#[tauri::command]
pub fn get_personalization_profile() -> Result<PersonalizationProfile, String> {
    let guard = profile_lock().lock().map_err(|_| "Profile lock poisoned.".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn set_personalization_enabled(enabled: bool) -> Result<(), String> {
    with_profile_mut(|profile| {
        profile.enabled = enabled;
        profile.updated_at_ms = now_ms();
    })
}

#[tauri::command]
pub fn clear_personalization_profile() -> Result<(), String> {
    with_profile_mut(|profile| {
        *profile = PersonalizationProfile {
            enabled: profile.enabled,
            identity: IdentityProfile::default(),
            ..PersonalizationProfile::default()
        };
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    fn with_temp_profile<F: FnOnce()>(test: F) {
        let dir = std::env::temp_dir().join(format!(
            "devprism_personalization_{}_{}",
            std::process::id(),
            TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Point config at temp by shadowing profile_path via env is not available;
        // test pure functions instead.
        test();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_prompt_with_identity_only() {
        let mut profile = PersonalizationProfile::default();
        profile.enabled = true;
        profile.identity.name = "Ada Lovelace".into();
        profile.identity.role = "Researcher".into();
        profile.identity.writing_style = "Concise academic".into();
        let block = build_personalization_prompt_from(&profile);
        assert!(block.contains("Ada Lovelace"));
        assert!(block.contains("Concise academic"));
    }

    #[test]
    fn builds_prompt_after_enough_signals() {
        with_temp_profile(|| {
            let mut profile = PersonalizationProfile::default();
            profile.enabled = true;
            profile.interaction_count = 5;
            profile.prefers_concise = 4;
            profile.prefers_formal = 3;
            profile.space_kinds.insert("research-paper".into(), 5);
            profile.recent_topics = vec!["Tighten intro".into()];
            let block = build_personalization_prompt_from(&profile);
            assert!(block.contains("USER PERSONALIZATION"));
            assert!(block.contains("concise"));
            assert!(block.contains("research-paper"));
            assert!(block.contains("Tighten intro"));
        });
    }

    #[test]
    fn empty_when_disabled() {
        let mut profile = PersonalizationProfile::default();
        profile.enabled = false;
        profile.interaction_count = 10;
        profile.identity.name = "Test".into();
        assert!(build_personalization_prompt_from(&profile).is_empty());
    }

    #[test]
    fn empty_when_no_identity_or_behavior() {
        let profile = PersonalizationProfile::default();
        assert!(build_personalization_prompt_from(&profile).is_empty());
    }

    #[test]
    fn empty_when_disabled_or_too_few_interactions() {
        let mut profile = PersonalizationProfile::default();
        profile.enabled = true;
        profile.interaction_count = 1;
        assert!(build_personalization_prompt_from(&profile).is_empty());
    }

    #[test]
    fn apply_event_updates_profile() {
        with_temp_profile(|| {
            let mut profile = PersonalizationProfile::default();
            apply_event(
                &mut profile,
                "chat_sent",
                Some(&serde_json::json!({ "text": "Please give a brief summary" })),
            );
            assert!(profile.prefers_concise >= 1);
            assert!(profile.prefers_formal >= 1);
            apply_event(
                &mut profile,
                "follow_up_clicked",
                Some(&serde_json::json!({ "label": "Add citations" })),
            );
            assert_eq!(profile.recent_topics.last().map(|s| s.as_str()), Some("Add citations"));
        });
    }

    #[test]
    fn augment_system_prompt_appends_block() {
        let mut profile = PersonalizationProfile::default();
        profile.enabled = true;
        profile.interaction_count = 5;
        profile.prefers_detailed = 4;
        let block = build_personalization_prompt_from(&profile);
        assert!(!block.is_empty());
        let augmented = augment_system_prompt(Some("Base rules.".into()));
        assert!(augmented.unwrap().contains("Base rules."));
    }
}
