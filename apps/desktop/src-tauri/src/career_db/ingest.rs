//! KB source ingestion.
//!
//! Path-based `ingest_source` keeps a minimal fallback chunker. Prefer the
//! frontend prepared-chunk path (`upsert_prepared_source`) for heading-aware
//! markdown/PDF/OPML chunking with per-chunk content-hash re-embedding.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const TARGET_CHUNK_CHARS: usize = 1200;
const OVERLAP_CHARS: usize = 180;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReport {
    pub source_id: String,
    pub chunk_count: usize,
    pub content_hash: String,
    pub skipped: bool,
    pub chunk_ids: Vec<String>,
    /// Chunk ids that need (re-)embedding after this upsert.
    #[serde(default)]
    pub needs_embedding: Vec<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedChunk {
    pub text: String,
    /// Opaque meta object; must include `contentHash` for per-chunk reuse.
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSource {
    pub uri: String,
    pub source_type: String,
    pub title: String,
    pub content_hash: String,
    pub chunks: Vec<PreparedChunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSourceRow {
    pub id: String,
    pub source_type: String,
    pub uri: Option<String>,
    pub title: Option<String>,
    pub content_hash: Option<String>,
    pub ingested_at: Option<i64>,
    pub chunk_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbChunkRow {
    pub id: String,
    pub source_id: String,
    pub text: String,
    pub meta: serde_json::Value,
    pub has_embedding: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha1::digest(bytes);
    format!("{digest:x}")
}

fn meta_content_hash(meta: &serde_json::Value) -> Option<String> {
    meta.get("contentHash")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn read_source_text(path: &Path) -> Result<(String, String), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("untitled")
        .to_string();
    // Minimal fallback: UTF-8 text. Binary PDFs should use the TS MuPDF path.
    match String::from_utf8(bytes.clone()) {
        Ok(text) => Ok((title, text)),
        Err(_) => Ok((
            title,
            format!(
                "[binary source; use frontend PDF/markdown ingest]\npath={}",
                path.display()
            ),
        )),
    }
}

/// Split text into overlapping character windows (fallback for path ingest).
pub fn chunk_text_minimal(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let paragraphs: Vec<&str> = trimmed
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();

    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();
    for para in paragraphs {
        if buf.is_empty() {
            buf.push_str(para);
        } else if buf.len() + 2 + para.len() <= TARGET_CHUNK_CHARS {
            buf.push_str("\n\n");
            buf.push_str(para);
        } else {
            chunks.push(buf.clone());
            let overlap = if buf.len() > OVERLAP_CHARS {
                buf[buf.len() - OVERLAP_CHARS..].to_string()
            } else {
                buf.clone()
            };
            buf = overlap;
            if !buf.is_empty() {
                buf.push_str("\n\n");
            }
            buf.push_str(para);
            if buf.len() > TARGET_CHUNK_CHARS * 2 {
                while buf.len() > TARGET_CHUNK_CHARS {
                    let cut = floor_char_boundary(&buf, TARGET_CHUNK_CHARS);
                    chunks.push(buf[..cut].to_string());
                    let start = cut.saturating_sub(OVERLAP_CHARS);
                    let start = floor_char_boundary(&buf, start);
                    buf = buf[start..].to_string();
                }
            }
        }
    }
    if !buf.trim().is_empty() {
        chunks.push(buf);
    }
    if chunks.is_empty() {
        chunks.push(trimmed.to_string());
    }
    chunks
}

fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn find_source_by_uri(
    conn: &Connection,
    uri: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    conn.query_row(
        "SELECT id, content_hash FROM kb_sources WHERE uri = ?1",
        params![uri],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map_err(|e| format!("Failed to look up kb_sources: {e}"))
}

fn list_chunk_ids(conn: &Connection, source_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM kb_chunks WHERE source_id = ?1")
        .map_err(|e| format!("Failed to list existing chunks: {e}"))?;
    let chunk_ids: Vec<String> = stmt
        .query_map(params![source_id], |r| r.get(0))
        .map_err(|e| format!("Failed to query chunks: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read chunk ids: {e}"))?;
    Ok(chunk_ids)
}

fn delete_chunks_and_embeddings(conn: &Connection, chunk_ids: &[String]) -> Result<(), String> {
    for cid in chunk_ids {
        super::vectors::delete_owner_embeddings(conn, cid)?;
        conn.execute("DELETE FROM kb_chunks WHERE id = ?1", params![cid])
            .map_err(|e| format!("Failed to delete chunk {cid}: {e}"))?;
    }
    Ok(())
}

/// Path-based ingest with minimal chunker (legacy / simple text files).
pub fn ingest_source(
    conn: &Connection,
    path: &str,
    source_type: &str,
) -> Result<IngestReport, String> {
    let path_buf = Path::new(path);
    if !path_buf.exists() {
        return Err(format!("Source path does not exist: {path}"));
    }
    let (title, text) = read_source_text(path_buf)?;
    let hash = content_hash(text.as_bytes());

    if let Some((source_id, existing_hash)) = find_source_by_uri(conn, path)? {
        if existing_hash.as_deref() == Some(hash.as_str()) {
            let chunk_ids = list_chunk_ids(conn, &source_id)?;
            return Ok(IngestReport {
                source_id,
                chunk_count: chunk_ids.len(),
                content_hash: hash,
                skipped: true,
                needs_embedding: Vec::new(),
                chunk_ids,
                title,
            });
        }
        let old_ids = list_chunk_ids(conn, &source_id)?;
        delete_chunks_and_embeddings(conn, &old_ids)?;
        conn.execute(
            "UPDATE kb_sources SET source_type = ?1, title = ?2, content_hash = ?3, ingested_at = ?4 WHERE id = ?5",
            params![source_type, title, hash, now_ms(), source_id],
        )
        .map_err(|e| format!("Failed to update kb_sources: {e}"))?;

        return insert_chunks_minimal(conn, &source_id, &title, &text, &hash);
    }

    let source_id = format!("src_{}", Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO kb_sources (id, source_type, uri, title, content_hash, ingested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![source_id, source_type, path, title, hash, now_ms()],
    )
    .map_err(|e| format!("Failed to insert kb_sources: {e}"))?;

    insert_chunks_minimal(conn, &source_id, &title, &text, &hash)
}

fn insert_chunks_minimal(
    conn: &Connection,
    source_id: &str,
    title: &str,
    text: &str,
    hash: &str,
) -> Result<IngestReport, String> {
    let chunks = chunk_text_minimal(text);
    let mut chunk_ids = Vec::with_capacity(chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        let chunk_id = format!("chk_{}", Uuid::new_v4().simple());
        let chunk_hash = content_hash(chunk.as_bytes());
        let meta = serde_json::json!({
            "sourceTitle": title,
            "headingPath": [],
            "index": i,
            "contentHash": chunk_hash,
        });
        let meta_json = serde_json::to_string(&meta)
            .map_err(|e| format!("Failed to serialize chunk meta: {e}"))?;
        conn.execute(
            "INSERT INTO kb_chunks (id, source_id, text, meta_json) VALUES (?1, ?2, ?3, ?4)",
            params![chunk_id, source_id, chunk, meta_json],
        )
        .map_err(|e| format!("Failed to insert chunk: {e}"))?;
        chunk_ids.push(chunk_id);
    }
    Ok(IngestReport {
        source_id: source_id.to_string(),
        chunk_count: chunk_ids.len(),
        content_hash: hash.to_string(),
        skipped: false,
        needs_embedding: chunk_ids.clone(),
        chunk_ids,
        title: title.to_string(),
    })
}

/// Upsert a frontend-prepared source. Unchanged chunk contentHashes keep their
/// ids (and embeddings); only new/changed chunks are inserted and returned in
/// `needs_embedding`.
pub fn upsert_prepared_source(
    conn: &Connection,
    prepared: &PreparedSource,
) -> Result<IngestReport, String> {
    if prepared.chunks.is_empty() {
        return Err("Prepared source has no chunks".to_string());
    }

    // Ensure every chunk carries a contentHash in meta.
    for (i, chunk) in prepared.chunks.iter().enumerate() {
        if meta_content_hash(&chunk.meta).is_none() {
            return Err(format!("Prepared chunk {i} missing meta.contentHash"));
        }
    }

    if let Some((source_id, existing_hash)) = find_source_by_uri(conn, &prepared.uri)? {
        if existing_hash.as_deref() == Some(prepared.content_hash.as_str()) {
            let chunk_ids = list_chunk_ids(conn, &source_id)?;
            // Source unchanged — still report any chunks missing embeddings.
            let needs = chunks_missing_embeddings(conn, Some(&source_id))?
                .into_iter()
                .map(|c| c.id)
                .collect();
            return Ok(IngestReport {
                source_id,
                chunk_count: chunk_ids.len(),
                content_hash: prepared.content_hash.clone(),
                skipped: true,
                needs_embedding: needs,
                chunk_ids,
                title: prepared.title.clone(),
            });
        }

        // Diff by per-chunk contentHash.
        let existing = load_source_chunks(conn, &source_id)?;
        let mut by_hash: HashMap<String, String> = HashMap::new();
        for row in &existing {
            if let Some(h) = meta_content_hash(&row.meta) {
                by_hash.insert(h, row.id.clone());
            }
        }

        let mut needs_embedding = Vec::new();
        let mut all_ids = Vec::new();
        let mut used_existing: HashMap<String, bool> = HashMap::new();

        for (i, chunk) in prepared.chunks.iter().enumerate() {
            let hash = meta_content_hash(&chunk.meta).unwrap_or_default();
            if let Some(existing_id) = by_hash.get(&hash) {
                all_ids.push(existing_id.clone());
                used_existing.insert(existing_id.clone(), true);
                // Reuse id; only re-embed if embedding is missing.
                let has_emb: bool = conn
                    .query_row(
                        "SELECT 1 FROM embeddings WHERE owner_id = ?1",
                        params![existing_id],
                        |_| Ok(true),
                    )
                    .optional()
                    .map_err(|e| format!("Failed to check embedding: {e}"))?
                    .unwrap_or(false);
                if !has_emb {
                    needs_embedding.push(existing_id.clone());
                }
            } else {
                let chunk_id = format!("chk_{}", Uuid::new_v4().simple());
                let mut meta = chunk.meta.clone();
                if let Some(obj) = meta.as_object_mut() {
                    obj.insert("index".into(), serde_json::json!(i));
                    obj.entry("sourceTitle".to_string())
                        .or_insert_with(|| serde_json::json!(prepared.title));
                }
                let meta_json = serde_json::to_string(&meta)
                    .map_err(|e| format!("Failed to serialize chunk meta: {e}"))?;
                conn.execute(
                    "INSERT INTO kb_chunks (id, source_id, text, meta_json) VALUES (?1, ?2, ?3, ?4)",
                    params![chunk_id, source_id, chunk.text, meta_json],
                )
                .map_err(|e| format!("Failed to insert chunk: {e}"))?;
                all_ids.push(chunk_id.clone());
                needs_embedding.push(chunk_id);
            }
        }

        // Drop chunks that disappeared from the source.
        let stale: Vec<String> = existing
            .iter()
            .filter(|r| !used_existing.contains_key(&r.id))
            .map(|r| r.id.clone())
            .collect();
        delete_chunks_and_embeddings(conn, &stale)?;

        conn.execute(
            "UPDATE kb_sources SET source_type = ?1, title = ?2, content_hash = ?3, ingested_at = ?4 WHERE id = ?5",
            params![
                prepared.source_type,
                prepared.title,
                prepared.content_hash,
                now_ms(),
                source_id
            ],
        )
        .map_err(|e| format!("Failed to update kb_sources: {e}"))?;

        return Ok(IngestReport {
            source_id,
            chunk_count: all_ids.len(),
            content_hash: prepared.content_hash.clone(),
            skipped: false,
            needs_embedding,
            chunk_ids: all_ids,
            title: prepared.title.clone(),
        });
    }

    // Brand-new source.
    let source_id = format!("src_{}", Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO kb_sources (id, source_type, uri, title, content_hash, ingested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            source_id,
            prepared.source_type,
            prepared.uri,
            prepared.title,
            prepared.content_hash,
            now_ms()
        ],
    )
    .map_err(|e| format!("Failed to insert kb_sources: {e}"))?;

    let mut chunk_ids = Vec::with_capacity(prepared.chunks.len());
    for (i, chunk) in prepared.chunks.iter().enumerate() {
        let chunk_id = format!("chk_{}", Uuid::new_v4().simple());
        let mut meta = chunk.meta.clone();
        if let Some(obj) = meta.as_object_mut() {
            obj.insert("index".into(), serde_json::json!(i));
            obj.entry("sourceTitle".to_string())
                .or_insert_with(|| serde_json::json!(prepared.title));
        }
        let meta_json = serde_json::to_string(&meta)
            .map_err(|e| format!("Failed to serialize chunk meta: {e}"))?;
        conn.execute(
            "INSERT INTO kb_chunks (id, source_id, text, meta_json) VALUES (?1, ?2, ?3, ?4)",
            params![chunk_id, source_id, chunk.text, meta_json],
        )
        .map_err(|e| format!("Failed to insert chunk: {e}"))?;
        chunk_ids.push(chunk_id);
    }

    Ok(IngestReport {
        source_id,
        chunk_count: chunk_ids.len(),
        content_hash: prepared.content_hash.clone(),
        skipped: false,
        needs_embedding: chunk_ids.clone(),
        chunk_ids,
        title: prepared.title.clone(),
    })
}

fn load_source_chunks(conn: &Connection, source_id: &str) -> Result<Vec<KbChunkRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.source_id, c.text, c.meta_json,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM embeddings e WHERE e.owner_id = c.id
                    ) THEN 1 ELSE 0 END
             FROM kb_chunks c
             WHERE c.source_id = ?1",
        )
        .map_err(|e| format!("Failed to prepare load chunks: {e}"))?;
    let rows = stmt
        .query_map(params![source_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("Failed to query source chunks: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let (id, sid, text, meta_json, has_emb) =
            row.map_err(|e| format!("Failed to read chunk row: {e}"))?;
        let meta: serde_json::Value = meta_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);
        out.push(KbChunkRow {
            id,
            source_id: sid,
            text,
            meta,
            has_embedding: has_emb != 0,
        });
    }
    Ok(out)
}

pub fn list_kb_sources(conn: &Connection) -> Result<Vec<KbSourceRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.source_type, s.uri, s.title, s.content_hash, s.ingested_at,
                    (SELECT COUNT(*) FROM kb_chunks c WHERE c.source_id = s.id)
             FROM kb_sources s
             ORDER BY s.ingested_at DESC",
        )
        .map_err(|e| format!("Failed to prepare list kb_sources: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(KbSourceRow {
                id: r.get(0)?,
                source_type: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                uri: r.get(2)?,
                title: r.get(3)?,
                content_hash: r.get(4)?,
                ingested_at: r.get(5)?,
                chunk_count: r.get(6)?,
            })
        })
        .map_err(|e| format!("Failed to query kb_sources: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read kb_sources: {e}"))
}

pub fn list_kb_chunks(
    conn: &Connection,
    source_id: Option<&str>,
    missing_embeddings_only: bool,
) -> Result<Vec<KbChunkRow>, String> {
    if missing_embeddings_only {
        return chunks_missing_embeddings(conn, source_id);
    }
    let mut sql = String::from(
        "SELECT c.id, c.source_id, c.text, c.meta_json,
                CASE WHEN EXISTS (
                  SELECT 1 FROM embeddings e WHERE e.owner_id = c.id
                ) THEN 1 ELSE 0 END
         FROM kb_chunks c",
    );
    if source_id.is_some() {
        sql.push_str(" WHERE c.source_id = ?1");
    }
    sql.push_str(" ORDER BY c.id ASC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare list chunks: {e}"))?;

    let mut rows = match source_id {
        Some(sid) => stmt
            .query(params![sid])
            .map_err(|e| format!("Failed to query chunks: {e}"))?,
        None => stmt
            .query([])
            .map_err(|e| format!("Failed to query chunks: {e}"))?,
    };

    let mut out = Vec::new();
    while let Some(r) = rows
        .next()
        .map_err(|e| format!("Failed to read chunk row: {e}"))?
    {
        let id: String = r.get(0).map_err(|e| format!("chunk id: {e}"))?;
        let sid: String = r.get(1).map_err(|e| format!("source id: {e}"))?;
        let text: String = r.get(2).map_err(|e| format!("chunk text: {e}"))?;
        let meta_json: Option<String> = r.get(3).map_err(|e| format!("meta: {e}"))?;
        let has_emb: i64 = r.get(4).map_err(|e| format!("has_emb: {e}"))?;
        let meta: serde_json::Value = meta_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);
        out.push(KbChunkRow {
            id,
            source_id: sid,
            text,
            meta,
            has_embedding: has_emb != 0,
        });
    }
    Ok(out)
}

pub fn chunks_missing_embeddings(
    conn: &Connection,
    source_id: Option<&str>,
) -> Result<Vec<KbChunkRow>, String> {
    let mut sql = String::from(
        "SELECT c.id, c.source_id, c.text, c.meta_json, 0
         FROM kb_chunks c
         WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.owner_id = c.id)",
    );
    if source_id.is_some() {
        sql.push_str(" AND c.source_id = ?1");
    }
    sql.push_str(" ORDER BY c.id ASC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare missing-embedding chunks: {e}"))?;

    let mut rows = match source_id {
        Some(sid) => stmt
            .query(params![sid])
            .map_err(|e| format!("Failed to query missing embeddings: {e}"))?,
        None => stmt
            .query([])
            .map_err(|e| format!("Failed to query missing embeddings: {e}"))?,
    };

    let mut out = Vec::new();
    while let Some(r) = rows
        .next()
        .map_err(|e| format!("Failed to read missing-embedding row: {e}"))?
    {
        let id: String = r
            .get(0)
            .map_err(|e| format!("Failed to read chunk id: {e}"))?;
        let sid: String = r
            .get(1)
            .map_err(|e| format!("Failed to read source id: {e}"))?;
        let text: String = r
            .get(2)
            .map_err(|e| format!("Failed to read chunk text: {e}"))?;
        let meta_json: Option<String> = r
            .get(3)
            .map_err(|e| format!("Failed to read chunk meta: {e}"))?;
        let meta: serde_json::Value = meta_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);
        out.push(KbChunkRow {
            id,
            source_id: sid,
            text,
            meta,
            has_embedding: false,
        });
    }
    Ok(out)
}

pub fn delete_kb_source(conn: &Connection, source_id: &str) -> Result<(), String> {
    let ids = list_chunk_ids(conn, source_id)?;
    delete_chunks_and_embeddings(conn, &ids)?;
    let n = conn
        .execute("DELETE FROM kb_sources WHERE id = ?1", params![source_id])
        .map_err(|e| format!("Failed to delete kb_sources: {e}"))?;
    if n == 0 {
        return Err(format!("KB source not found: {source_id}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn chunk_text_splits_paragraphs() {
        let text = "para one\n\npara two\n\npara three that is longer";
        let chunks = chunk_text_minimal(text);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().any(|c| c.contains("para one")));
    }

    #[test]
    fn prepared_upsert_reuses_unchanged_chunks() {
        let conn = mem_conn();
        let hash1 = content_hash(b"hello world");
        let prepared = PreparedSource {
            uri: "/tmp/wiki.md".into(),
            source_type: "markdown".into(),
            title: "wiki".into(),
            content_hash: "src_hash_v1".into(),
            chunks: vec![PreparedChunk {
                text: "hello world".into(),
                meta: serde_json::json!({
                    "sourceTitle": "wiki",
                    "headingPath": ["Intro"],
                    "contentHash": hash1,
                }),
            }],
        };
        let r1 = upsert_prepared_source(&conn, &prepared).unwrap();
        assert_eq!(r1.chunk_count, 1);
        assert_eq!(r1.needs_embedding.len(), 1);
        let first_id = r1.chunk_ids[0].clone();

        // Same source hash → skipped.
        let r_skip = upsert_prepared_source(&conn, &prepared).unwrap();
        assert!(r_skip.skipped);
        assert_eq!(r_skip.chunk_ids, vec![first_id.clone()]);

        // Changed source hash but same chunk hash → reuse id, no re-embed needed
        // once we store a fake embedding.
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, 'chunk', 'test', 2, ?2)",
            params![first_id, vec![0u8, 0, 0, 0, 0, 0, 0, 0]],
        )
        .unwrap();

        let mut prepared2 = prepared.clone();
        prepared2.content_hash = "src_hash_v2".into();
        prepared2.chunks.push(PreparedChunk {
            text: "brand new".into(),
            meta: serde_json::json!({
                "sourceTitle": "wiki",
                "headingPath": ["Outro"],
                "contentHash": content_hash(b"brand new"),
            }),
        });
        let r2 = upsert_prepared_source(&conn, &prepared2).unwrap();
        assert!(!r2.skipped);
        assert_eq!(r2.chunk_count, 2);
        assert!(r2.chunk_ids.contains(&first_id));
        assert_eq!(r2.needs_embedding.len(), 1);
        assert!(!r2.needs_embedding.contains(&first_id));
    }
}
