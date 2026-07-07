use super::SemanticLayerConfig;
use super::math::cosine_similarity;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Clone)]
struct CacheEntry {
    embedding: Vec<f32>,
    response: String,
    created_at: Instant,
    last_accessed: Instant,
}

pub struct SemanticCache {
    entries: HashMap<String, CacheEntry>,
}

impl Default for SemanticCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl SemanticCache {
    pub fn lookup(
        &mut self,
        embedding: &[f32],
        cache_key: &str,
        config: &SemanticLayerConfig,
    ) -> CacheLookupResult {
        let now = Instant::now();
        let ttl = config.cache_ttl();
        self.evict_expired(now, ttl);

        if let Some(exact) = self.entries.get_mut(cache_key) {
            if now.duration_since(exact.created_at) <= ttl {
                exact.last_accessed = now;
                return CacheLookupResult {
                    hit: true,
                    response: Some(exact.response.clone()),
                    score: Some(1.0),
                };
            }
        }

        let threshold = effective_hit_threshold(config, self.entries.len());
        let mut best: Option<(f32, String)> = None;

        for entry in self.entries.values() {
            if now.duration_since(entry.created_at) > ttl {
                continue;
            }
            let score = cosine_similarity(embedding, &entry.embedding);
            if best.as_ref().map_or(true, |(s, _)| score > *s) {
                best = Some((score, entry.response.clone()));
            }
        }

        let Some((score, response)) = best else {
            return CacheLookupResult {
                hit: false,
                response: None,
                score: None,
            };
        };

        if score >= threshold {
            return CacheLookupResult {
                hit: true,
                response: Some(response),
                score: Some(score),
            };
        }

        if score < config.gray_zone_low() {
            return CacheLookupResult {
                hit: false,
                response: None,
                score: Some(score),
            };
        }

        CacheLookupResult {
            hit: false,
            response: None,
            score: Some(score),
        }
    }

    pub fn store(
        &mut self,
        cache_key: &str,
        embedding: Vec<f32>,
        response: &str,
        config: &SemanticLayerConfig,
    ) {
        let now = Instant::now();
        let ttl = config.cache_ttl();
        self.evict_expired(now, ttl);

        if let Some(existing) = self.entries.get_mut(cache_key) {
            existing.embedding = embedding;
            existing.response = response.to_string();
            existing.created_at = now;
            existing.last_accessed = now;
            return;
        }

        while self.entries.len() >= config.max_cache_entries() {
            self.evict_lru();
        }

        self.entries.insert(
            cache_key.to_string(),
            CacheEntry {
                embedding,
                response: response.to_string(),
                created_at: now,
                last_accessed: now,
            },
        );
    }

    fn evict_expired(&mut self, now: Instant, ttl: std::time::Duration) {
        self.entries
            .retain(|_, entry| now.duration_since(entry.created_at) <= ttl);
    }

    fn evict_lru(&mut self) {
        if let Some(key) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_accessed)
            .map(|(key, _)| key.clone())
        {
            self.entries.remove(&key);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

pub struct CacheLookupResult {
    pub hit: bool,
    pub response: Option<String>,
    pub score: Option<f32>,
}

pub fn cache_key_for(system: Option<&str>, prompt: &str) -> String {
    format!("{}\0{}", system.unwrap_or(""), prompt)
}

fn effective_hit_threshold(config: &SemanticLayerConfig, cache_size: usize) -> f32 {
    let fill = cache_size as f32 / config.max_cache_entries().max(1) as f32;
    (config.hit_threshold() + fill * 0.03).min(0.98)
}
