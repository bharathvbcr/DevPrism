use crate::agent::tools::Tool;
use crate::agent::knowledge::vector_store::VectorStore;
use async_trait::async_trait;
use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub struct SemanticSearchTool {
    pub vector_store: std::sync::Arc<VectorStore>,
}

impl SemanticSearchTool {
    pub async fn get_embedding(text: &str) -> Result<Vec<f32>, String> {
        let api_key = env::var("GEMINI_API_KEY").map_err(|_| "GEMINI_API_KEY must be set for semantic search".to_string())?;
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={}", api_key);
        
        let client = reqwest::Client::new();
        let res = client.post(&url)
            .json(&json!({
                "model": "models/text-embedding-004",
                "content": {
                    "parts": [{ "text": text }]
                }
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Embedding API error: {}", err));
        }

        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        
        let embedding = data["embedding"]["values"]
            .as_array()
            .ok_or("No embedding values found in response")?
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();
            
        Ok(embedding)
    }
}

#[async_trait]
impl Tool for SemanticSearchTool {
    fn name(&self) -> &str {
        "semantic_search"
    }

    fn description(&self) -> &str {
        "Search through indexed project files using semantic similarity (RAG). Useful for answering conceptual questions about the codebase."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (e.g., 'Where is authentication handled?')"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of chunks to return (default: 5)"
                }
            },
            "required": ["query"]
        })
    }

    async fn call(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let query = input["query"].as_str().ok_or("Parameter 'query' is required")?;
        let limit = input["limit"].as_u64().unwrap_or(5) as usize;

        let query_embedding = Self::get_embedding(query).await?;
        
        let results = self.vector_store.search(&query_embedding, limit).map_err(|e| e.to_string())?;
        
        let mut formatted_results = Vec::new();
        for (chunk, score) in results {
            formatted_results.push(json!({
                "file_path": chunk.file_path,
                "score": score,
                "content_snippet": chunk.content
            }));
        }

        Ok(json!({
            "query": query,
            "results": formatted_results
        }))
    }
}

pub struct IndexProjectTool {
    pub vector_store: std::sync::Arc<VectorStore>,
}

#[async_trait]
impl Tool for IndexProjectTool {
    fn name(&self) -> &str {
        "index_project"
    }

    fn description(&self) -> &str {
        "Index the current project directory for semantic search. This will chunk and embed the files. Run this before using semantic_search."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "project_path": {
                    "type": "string",
                    "description": "The absolute path to the project directory to index"
                }
            },
            "required": ["project_path"]
        })
    }

    async fn call(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let project_path = input["project_path"].as_str().ok_or("Parameter 'project_path' is required")?;
        let path = Path::new(project_path);

        if (!path.exists()) {
            return Err("Project path does not exist".into());
        }

        let mut count = 0;
        
        // Simple recursive file read (ignoring node_modules and target for now)
        let entries = walkdir::WalkDir::new(path)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| !e.file_type().is_dir())
            .filter(|e| {
                let path_str = e.path().to_string_lossy();
                !path_str.contains("node_modules") && !path_str.contains("target") && !path_str.contains(".git")
            });

        for entry in entries {
            if let Ok(content) = fs::read_to_string(entry.path()) {
                // Chunking logic (very basic, 1000 chars)
                let chunks: Vec<String> = content
                    .chars()
                    .collect::<Vec<char>>()
                    .chunks(1000)
                    .map(|c| c.iter().collect::<String>())
                    .collect();

                let rel_path = entry.path().strip_prefix(path).unwrap_or(entry.path()).to_string_lossy().to_string();
                
                // Clear existing chunks for this file
                let _ = self.vector_store.clear_for_file(&rel_path);

                for chunk in chunks {
                    if chunk.trim().is_empty() { continue; }
                    match SemanticSearchTool::get_embedding(&chunk).await {
                        Ok(embedding) => {
                            let _ = self.vector_store.insert_chunk(&rel_path, &chunk, &embedding);
                            count += 1;
                        },
                        Err(_) => {
                            // Ignore embedding failures, usually rate limits or unsupported chars
                        }
                    }
                }
            }
        }

        Ok(json!({
            "success": true,
            "message": format!("Successfully indexed {} chunks.", count)
        }))
    }
}
