#![allow(dead_code)]

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentChunk {
    pub id: i64,
    pub file_path: String,
    pub content: String,
    pub embedding: Vec<f32>,
}

pub struct VectorStore {
    conn: Connection,
}

impl VectorStore {
    pub fn new(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS document_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding_json TEXT NOT NULL
            )",
            [],
        )?;

        Ok(Self { conn })
    }

    pub fn insert_chunk(&self, file_path: &str, content: &str, embedding: &[f32]) -> Result<()> {
        let embedding_json = serde_json::to_string(embedding).unwrap();
        self.conn.execute(
            "INSERT INTO document_chunks (file_path, content, embedding_json) VALUES (?1, ?2, ?3)",
            params![file_path, content, embedding_json],
        )?;
        Ok(())
    }

    pub fn clear_for_file(&self, file_path: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM document_chunks WHERE file_path = ?1",
            params![file_path],
        )?;
        Ok(())
    }

    pub fn get_all_chunks(&self) -> Result<Vec<DocumentChunk>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, file_path, content, embedding_json FROM document_chunks")?;
        let chunk_iter = stmt.query_map([], |row| {
            let embedding_json: String = row.get(3)?;
            let embedding: Vec<f32> = serde_json::from_str(&embedding_json).unwrap_or_default();
            Ok(DocumentChunk {
                id: row.get(0)?,
                file_path: row.get(1)?,
                content: row.get(2)?,
                embedding,
            })
        })?;

        let mut chunks = Vec::new();
        for chunk in chunk_iter {
            chunks.push(chunk?);
        }
        Ok(chunks)
    }

    pub fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<(DocumentChunk, f32)>> {
        let chunks = self.get_all_chunks()?;

        let mut scored_chunks: Vec<(DocumentChunk, f32)> = chunks
            .into_iter()
            .map(|chunk| {
                let score = cosine_similarity(query_embedding, &chunk.embedding);
                (chunk, score)
            })
            .collect();

        // Sort descending by score
        scored_chunks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        scored_chunks.truncate(limit);
        Ok(scored_chunks)
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot_product = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..a.len() {
        dot_product += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot_product / (norm_a.sqrt() * norm_b.sqrt())
}
