mod cache;
pub(crate) mod math;
mod router;

use crate::native_agent::ollama;
use cache::{cache_key_for, CacheLookupResult, SemanticCache};
use router::route_query;
use serde::{Deserialize, Serialize};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

const DEFAULT_MAX_CACHE_ENTRIES: usize = 256;
const DEFAULT_CACHE_TTL_SECS: u64 = 30 * 60;
const DEFAULT_HIT_THRESHOLD: f32 = 0.92;
const DEFAULT_GRAY_ZONE_LOW: f32 = 0.85;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticLayerConfig {
    pub enabled: bool,
    pub cache_enabled: bool,
    pub router_enabled: bool,
    pub compressor_enabled: bool,
    pub light_model: Option<String>,
    pub medium_model: Option<String>,
    pub heavy_model: Option<String>,
    pub ollama_base_url: String,
}

impl Default for SemanticLayerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cache_enabled: true,
            router_enabled: true,
            compressor_enabled: true,
            light_model: None,
            medium_model: None,
            heavy_model: None,
            ollama_base_url: "http://localhost:11434".to_string(),
        }
    }
}

impl SemanticLayerConfig {
    pub(crate) fn cache_ttl(&self) -> Duration {
        Duration::from_secs(DEFAULT_CACHE_TTL_SECS)
    }

    pub(crate) fn max_cache_entries(&self) -> usize {
        DEFAULT_MAX_CACHE_ENTRIES
    }

    pub(crate) fn hit_threshold(&self) -> f32 {
        DEFAULT_HIT_THRESHOLD
    }

    pub(crate) fn gray_zone_low(&self) -> f32 {
        DEFAULT_GRAY_ZONE_LOW
    }
}

static CONFIG: OnceLock<RwLock<SemanticLayerConfig>> = OnceLock::new();
static CACHE: OnceLock<RwLock<SemanticCache>> = OnceLock::new();

fn config_lock() -> &'static RwLock<SemanticLayerConfig> {
    CONFIG.get_or_init(|| RwLock::new(SemanticLayerConfig::default()))
}

fn cache_lock() -> &'static RwLock<SemanticCache> {
    CACHE.get_or_init(|| RwLock::new(SemanticCache::default()))
}

#[derive(Clone, Debug)]
pub struct PreparedInference {
    pub prompt: String,
    pub system: Option<String>,
    pub model: String,
    pub cached_response: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticCacheLookupResult {
    pub hit: bool,
    pub response: Option<String>,
    pub score: Option<f32>,
}

#[tauri::command]
pub fn sync_semantic_layer_config(config: SemanticLayerConfig) -> Result<(), String> {
    let mut guard = config_lock()
        .write()
        .map_err(|_| "Semantic layer config lock poisoned".to_string())?;
    *guard = config;
    Ok(())
}

/// Shared in-memory cache lookup for frontend inference paths (fail-open).
#[tauri::command]
pub fn semantic_cache_lookup(
    embedding: Vec<f32>,
    cache_key: String,
) -> Result<SemanticCacheLookupResult, String> {
    let config = current_config();
    if !config.enabled || !config.cache_enabled {
        return Ok(SemanticCacheLookupResult {
            hit: false,
            response: None,
            score: None,
        });
    }

    let lookup = cache_lock()
        .write()
        .map_err(|_| "Semantic layer cache lock poisoned".to_string())?
        .lookup(&embedding, &cache_key, &config);

    Ok(SemanticCacheLookupResult {
        hit: lookup.hit,
        response: lookup.response,
        score: lookup.score,
    })
}

/// Store a successful inference in the shared cache (fail-open).
#[tauri::command]
pub fn semantic_cache_store(
    cache_key: String,
    embedding: Vec<f32>,
    response: String,
) -> Result<(), String> {
    let config = current_config();
    if !config.enabled || !config.cache_enabled {
        return Ok(());
    }

    let mut cache = cache_lock()
        .write()
        .map_err(|_| "Semantic layer cache lock poisoned".to_string())?;
    cache.store(&cache_key, embedding, &response, &config);
    Ok(())
}

#[tauri::command]
pub fn semantic_cache_clear() -> Result<(), String> {
    cache_lock()
        .write()
        .map_err(|_| "Semantic layer cache lock poisoned".to_string())?
        .clear();
    Ok(())
}

pub fn current_config() -> SemanticLayerConfig {
    config_lock().read().map(|g| g.clone()).unwrap_or_default()
}

/// Pre-inference semantic pass for the anthropic proxy path. Fail-open.
pub async fn prepare_proxy_inference(
    system: Option<&str>,
    prompt: &str,
    default_model: &str,
    skip_cache: bool,
) -> PreparedInference {
    let config = current_config();
    let base = PreparedInference {
        prompt: prompt.to_string(),
        system: system.map(str::to_string),
        model: default_model.to_string(),
        cached_response: None,
    };

    if !config.enabled {
        return base;
    }

    let embed_text = match system {
        Some(sys) if !sys.trim().is_empty() => format!("{}\n---\n{}", sys.trim(), prompt),
        _ => prompt.to_string(),
    };

    let vectors = match embed_texts(&config, &[embed_text]).await {
        Ok(v) => v,
        Err(_) => return apply_router(base, &config, prompt, system),
    };

    let Some(query_vec) = vectors.first() else {
        return apply_router(base, &config, prompt, system);
    };

    if config.cache_enabled && !skip_cache {
        let key = cache_key_for(system, prompt);
        let lookup = cache_lock()
            .write()
            .ok()
            .map(|mut cache| cache.lookup(query_vec, &key, &config))
            .unwrap_or(CacheLookupResult {
                hit: false,
                response: None,
                score: None,
            });

        if lookup.hit {
            if let Some(response) = lookup.response {
                return PreparedInference {
                    cached_response: Some(response),
                    ..base
                };
            }
        }
    }

    apply_router(base, &config, prompt, system)
}

pub async fn store_proxy_cache(system: Option<&str>, prompt: &str, response: &str) {
    let config = current_config();
    if !config.enabled || !config.cache_enabled {
        return;
    }

    let embed_text = match system {
        Some(sys) if !sys.trim().is_empty() => format!("{}\n---\n{}", sys.trim(), prompt),
        _ => prompt.to_string(),
    };

    let Ok(vectors) = embed_texts(&config, &[embed_text]).await else {
        return;
    };
    let Some(vec) = vectors.into_iter().next() else {
        return;
    };

    let key = cache_key_for(system, prompt);
    if let Ok(mut cache) = cache_lock().write() {
        cache.store(&key, vec, response, &config);
    }
}

fn apply_router(
    mut base: PreparedInference,
    config: &SemanticLayerConfig,
    prompt: &str,
    system: Option<&str>,
) -> PreparedInference {
    if !config.router_enabled {
        return base;
    }

    let decision = route_query(prompt, config, &base.model, system);
    if let Some(model) = decision.model_override {
        base.model = model;
    }
    base
}

async fn embed_texts(
    config: &SemanticLayerConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let model = match ollama::first_embedding_model(&config.ollama_base_url).await? {
        Some(m) => m,
        None => {
            return Err("[E_NO_MODEL] No embedding model installed".into());
        }
    };
    let client = ollama::OllamaClient::new(&config.ollama_base_url, &model, None, None);
    client.embed(texts).await
}

/// Extract system prompt and the last user text from an Anthropic messages request.
pub fn extract_prompt_from_anthropic(body: &serde_json::Value) -> (Option<String>, String) {
    let system = body
        .get("system")
        .and_then(|value| flatten_anthropic_content(Some(value)));

    let mut last_user = String::new();
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for message in messages {
            if message.get("role").and_then(|v| v.as_str()) != Some("user") {
                continue;
            }
            if let Some(text) = flatten_anthropic_content(message.get("content")) {
                if !text.trim().is_empty() {
                    last_user = text;
                }
            }
        }
    }

    (system.filter(|s| !s.trim().is_empty()), last_user)
}

fn flatten_anthropic_content(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(blocks) = value.as_array() {
        let mut parts = Vec::new();
        for block in blocks {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    parts.push(text);
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_cache_lookup_and_store_round_trip() {
        let mut config = SemanticLayerConfig::default();
        config.enabled = true;
        config.cache_enabled = true;
        sync_semantic_layer_config(config).unwrap();

        semantic_cache_store("key".to_string(), vec![1.0, 0.0, 0.0], "stored".to_string()).unwrap();

        let hit = semantic_cache_lookup(vec![1.0, 0.0, 0.0], "key".to_string()).unwrap();
        assert!(hit.hit);
        assert_eq!(hit.response.as_deref(), Some("stored"));

        semantic_cache_clear().unwrap();
        let miss = semantic_cache_lookup(vec![1.0, 0.0, 0.0], "key".to_string()).unwrap();
        assert!(!miss.hit);
    }

    #[test]
    fn extracts_last_user_message() {
        let body = serde_json::json!({
            "system": "You are helpful.",
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "ok" },
                { "role": "user", "content": [{ "type": "text", "text": "second question" }] }
            ]
        });
        let (system, prompt) = extract_prompt_from_anthropic(&body);
        assert_eq!(system.as_deref(), Some("You are helpful."));
        assert_eq!(prompt, "second question");
    }
}
