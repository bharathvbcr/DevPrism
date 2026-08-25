//! KB source ingestion.
//!
//! Path-based `ingest_source` keeps a minimal fallback chunker. Prefer the
//! frontend prepared-chunk path (`upsert_prepared_source`) for heading-aware
//! markdown/PDF/OPML chunking with per-chunk content-hash re-embedding.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const TARGET_CHUNK_CHARS: usize = 1200;
const OVERLAP_CHARS: usize = 180;
/// Most chunks one prepared source may carry. The byte cap below bounds text
/// volume; this bounds row count so a pathological chunker cannot stall the
/// DB mutex with tens of thousands of inserts.
const MAX_PREPARED_CHUNKS: usize = 2048;

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
    // Stat before reading: refuse non-regular files outright and never pull an
    // unbounded file into memory (same cap the MCP ingest path enforces).
    let meta =
        fs::metadata(path).map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!(
            "Source is not a regular file: {}",
            path.display()
        ));
    }
    let max_bytes = crate::mcp::tools_career::MAX_TEXT_BYTES;
    if meta.len() > max_bytes as u64 {
        return Err(format!(
            "Source {} is {} bytes, exceeding the {max_bytes}-byte limit",
            path.display(),
            meta.len()
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("untitled")
        .to_string();
    // Minimal fallback: UTF-8 text. Binary PDFs should use the TS MuPDF path.
    match String::from_utf8(bytes) {
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
                // `buf.len() - OVERLAP_CHARS` is a byte offset, and slicing a
                // `str` at a non-boundary byte panics. The two slices a few lines
                // below already guard with `floor_char_boundary`; this one did
                // not, so any multi-byte character straddling `len - 180` — an
                // apostrophe, an em dash, any CJK or emoji text — crashed the
                // ingest and poisoned the career DB mutex for the process.
                let start = floor_char_boundary(&buf, buf.len() - OVERLAP_CHARS);
                buf[start..].to_string()
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

/// Delete chunks together with their embeddings inside the caller's
/// transaction — the enclosing write must land or fail as a whole.
fn delete_chunks_and_embeddings(tx: &Transaction<'_>, chunk_ids: &[String]) -> Result<(), String> {
    for cid in chunk_ids {
        super::vectors::delete_owner_embeddings(tx, cid)?;
        tx.execute("DELETE FROM kb_chunks WHERE id = ?1", params![cid])
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
        // Re-ingest must be all-or-nothing.
        //
        // These three steps ran in autocommit, so each committed independently:
        // the old chunks and their embeddings were deleted, the source row was
        // updated to record the *new* content hash, and then the insert could
        // still fail (a panic in the chunker, or plain `SQLITE_BUSY`). The
        // source was then permanently recorded as ingested with zero chunks —
        // and because the stored hash already matched, re-ingesting the same
        // file short-circuits as `skipped: true`, so it could never self-heal.
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin re-ingest transaction: {e}"))?;

        let old_ids = list_chunk_ids(&tx, &source_id)?;
        delete_chunks_and_embeddings(&tx, &old_ids)?;
        tx.execute(
            "UPDATE kb_sources SET source_type = ?1, title = ?2, content_hash = ?3, ingested_at = ?4 WHERE id = ?5",
            params![source_type, title, hash, now_ms(), source_id],
        )
        .map_err(|e| format!("Failed to update kb_sources: {e}"))?;

        let report = insert_chunks_minimal(&tx, &source_id, &title, &text, &hash)?;
        tx.commit()
            .map_err(|e| format!("Failed to commit re-ingest: {e}"))?;
        return Ok(report);
    }

    // New sources are all-or-nothing too: the source row and every chunk land
    // in one transaction, so a mid-loop failure cannot leave a hash recorded
    // as ingested with chunks missing (that short-circuits future re-ingests
    // of identical content as 'skipped' forever).
    let source_id = format!("src_{}", Uuid::new_v4().simple());
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin ingest transaction: {e}"))?;
    tx.execute(
        "INSERT INTO kb_sources (id, source_type, uri, title, content_hash, ingested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![source_id, source_type, path, title, hash, now_ms()],
    )
    .map_err(|e| format!("Failed to insert kb_sources: {e}"))?;

    let report = insert_chunks_minimal(&tx, &source_id, &title, &text, &hash)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit ingest: {e}"))?;
    Ok(report)
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

    // Enforce the MCP-side input caps here in the storage layer, so the direct
    // webview command inherits them instead of bypassing them.
    let max_bytes = crate::mcp::tools_career::MAX_TEXT_BYTES;
    let total_bytes: usize = prepared.chunks.iter().map(|c| c.text.len()).sum();
    if total_bytes > max_bytes {
        return Err(format!(
            "Prepared source is {total_bytes} bytes, exceeding the {max_bytes}-byte limit"
        ));
    }
    if prepared.chunks.len() > MAX_PREPARED_CHUNKS {
        return Err(format!(
            "Prepared source has {} chunks, exceeding the {MAX_PREPARED_CHUNKS}-chunk limit",
            prepared.chunks.len()
        ));
    }

    // Every chunk must be non-empty and carry a contentHash in meta.
    for (i, chunk) in prepared.chunks.iter().enumerate() {
        if chunk.text.trim().is_empty() {
            return Err(format!("Prepared chunk {i} is empty"));
        }
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
        let active_model = super::vectors::active_embed_model(conn)?;
        // One hash can legitimately match several rows: a document may repeat a
        // paragraph verbatim. Keep a queue per hash so each occurrence claims a
        // distinct row. A single-id map hands the same row to every duplicate,
        // and the rest are then deleted below as "stale" — silently losing
        // chunks on a re-ingest that changed nothing.
        let mut by_hash: HashMap<String, VecDeque<String>> = HashMap::new();
        for row in &existing {
            if let Some(h) = meta_content_hash(&row.meta) {
                by_hash.entry(h).or_default().push_back(row.id.clone());
            }
        }

        let mut needs_embedding = Vec::new();
        let mut all_ids = Vec::new();
        let mut used_existing: HashMap<String, bool> = HashMap::new();

        // Every mutation below — index refreshes, inserts, stale deletions and
        // the source-row update — commits or fails as one unit.
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin KB re-ingest transaction: {e}"))?;

        for (i, chunk) in prepared.chunks.iter().enumerate() {
            let hash = meta_content_hash(&chunk.meta).unwrap_or_default();
            // A matching hash is necessary but not sufficient: verify the
            // stored text actually agrees before reusing the row, otherwise a
            // corrupted meta_json (or a genuine collision) pins stale content
            // in place forever.
            let mut reused_id: Option<String> = None;
            while let Some(candidate) = by_hash.get_mut(&hash).and_then(|q| q.pop_front()) {
                let agrees = existing
                    .iter()
                    .find(|r| r.id == candidate)
                    .is_some_and(|r| r.text == chunk.text);
                if agrees {
                    reused_id = Some(candidate);
                    break;
                }
                // Mismatching candidates stay unconsumed by the reuse map and
                // are therefore dropped as stale below.
            }
            if let Some(existing_id) = reused_id.as_ref() {
                // The text is unchanged but its position may not be. `index` is
                // what the KB viewer sorts by (sortKbChunksForDisplay), so a
                // reused row carrying its old index corrupts document order and
                // can duplicate an index. Rewrite it when it has drifted.
                if let Some(row) = existing.iter().find(|r| r.id == *existing_id) {
                    if row.meta.get("index").and_then(|v| v.as_i64()) != Some(i as i64) {
                        let mut meta = row.meta.clone();
                        if let Some(obj) = meta.as_object_mut() {
                            obj.insert("index".into(), serde_json::json!(i));
                        }
                        let meta_json = serde_json::to_string(&meta)
                            .map_err(|e| format!("Failed to serialize chunk meta: {e}"))?;
                        tx.execute(
                            "UPDATE kb_chunks SET meta_json = ?1 WHERE id = ?2",
                            params![meta_json, existing_id],
                        )
                        .map_err(|e| format!("Failed to refresh chunk index: {e}"))?;
                    }
                }
                all_ids.push(existing_id.clone());
                used_existing.insert(existing_id.clone(), true);
                // Reuse id; only re-embed if no embedding exists under the
                // active model (PK is (owner_id, model), so an unqualified
                // check would mask a switched embed model).
                let has_emb =
                    chunk_has_embedding(&tx, existing_id, active_model.as_deref())?;
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
                tx.execute(
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
        delete_chunks_and_embeddings(&tx, &stale)?;

        tx.execute(
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

        tx.commit()
            .map_err(|e| format!("Failed to commit KB re-ingest: {e}"))?;

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

    // Brand-new source. Source row and chunks commit together: a partial
    // ingest must never record a content hash for content that is not there.
    let source_id = format!("src_{}", Uuid::new_v4().simple());
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin KB ingest transaction: {e}"))?;
    tx.execute(
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
        tx.execute(
            "INSERT INTO kb_chunks (id, source_id, text, meta_json) VALUES (?1, ?2, ?3, ?4)",
            params![chunk_id, source_id, chunk.text, meta_json],
        )
        .map_err(|e| format!("Failed to insert chunk: {e}"))?;
        chunk_ids.push(chunk_id);
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit KB ingest: {e}"))?;

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

/// Does this chunk have an embedding under the active embed model?
///
/// The `embeddings` PK is `(owner_id, model)`; an unqualified existence check
/// counts a row stored under a retired model as current and silently skips
/// re-embedding after a model switch. With no recorded active model (nothing
/// has been stored yet), any model counts, preserving pre-qualification
/// behaviour.
fn chunk_has_embedding(
    conn: &Connection,
    chunk_id: &str,
    active_model: Option<&str>,
) -> Result<bool, String> {
    let sql = match active_model {
        Some(_) => "SELECT 1 FROM embeddings WHERE owner_id = ?1 AND model = ?2",
        None => "SELECT 1 FROM embeddings WHERE owner_id = ?1",
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to check embedding: {e}"))?;
    let found = match active_model {
        Some(m) => stmt.query_row(params![chunk_id, m], |_| Ok(true)).optional(),
        None => stmt.query_row(params![chunk_id], |_| Ok(true)).optional(),
    }
    .map_err(|e| format!("Failed to check embedding: {e}"))?;
    Ok(found.unwrap_or(false))
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
    // Qualify by the active embed model: a chunk holding only a retired
    // model's embedding still needs re-embedding.
    let active = super::vectors::active_embed_model(conn)?;
    let mut sql = String::from(
        "SELECT c.id, c.source_id, c.text, c.meta_json, 0
         FROM kb_chunks c
         WHERE NOT EXISTS (
           SELECT 1 FROM embeddings e WHERE e.owner_id = c.id",
    );
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(m) = active.as_deref() {
        sql.push_str(" AND e.model = ?");
        bind.push(Box::new(m.to_string()));
    }
    sql.push(')');
    if source_id.is_some() {
        sql.push_str(" AND c.source_id = ?");
    }
    sql.push_str(" ORDER BY c.id ASC");

    if let Some(sid) = source_id {
        bind.push(Box::new(sid.to_string()));
    }

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare missing-embedding chunks: {e}"))?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt
        .query(params_refs.as_slice())
        .map_err(|e| format!("Failed to query missing embeddings: {e}"))?;

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

/// Count KB chunks that have no embedding under the active model (readiness /
/// badges). See `chunks_missing_embeddings` for the model qualification.
pub fn count_kb_chunks_missing_embeddings(
    conn: &Connection,
    source_id: Option<&str>,
) -> Result<u32, String> {
    let active = super::vectors::active_embed_model(conn)?;
    let mut sql = String::from(
        "SELECT COUNT(*) FROM kb_chunks c
         WHERE NOT EXISTS (
           SELECT 1 FROM embeddings e WHERE e.owner_id = c.id",
    );
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(m) = active.as_deref() {
        sql.push_str(" AND e.model = ?");
        bind.push(Box::new(m.to_string()));
    }
    sql.push(')');
    if let Some(sid) = source_id {
        sql.push_str(" AND c.source_id = ?");
        bind.push(Box::new(sid.to_string()));
    }

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to count missing KB embeddings: {e}"))?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let count: i64 = stmt
        .query_row(params_refs.as_slice(), |r| r.get(0))
        .map_err(|e| format!("Failed to count missing KB embeddings: {e}"))?;
    Ok(count.max(0) as u32)
}

pub fn delete_kb_source(conn: &Connection, source_id: &str) -> Result<(), String> {
    // Existence BEFORE mutation: the previous order deleted every chunk (and
    // its embeddings) for the id and only afterwards failed with 'KB source
    // not found' — mutating the DB on a miss.
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM kb_sources WHERE id = ?1",
            params![source_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to look up kb_sources: {e}"))?;
    if exists.is_none() {
        return Err(format!("KB source not found: {source_id}"));
    }

    let ids = list_chunk_ids(conn, source_id)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin KB source delete: {e}"))?;
    delete_chunks_and_embeddings(&tx, &ids)?;
    tx.execute("DELETE FROM kb_sources WHERE id = ?1", params![source_id])
        .map_err(|e| format!("Failed to delete kb_sources: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit KB source delete: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {

    /// The overlap slice was the one byte-offset cut in this function without a
    /// `floor_char_boundary` guard, while the two below it had one. Any
    /// multi-byte character straddling `len - OVERLAP_CHARS` panicked — and the
    /// panic poisoned the career DB mutex for the rest of the process.
    #[test]
    fn chunking_survives_multibyte_text_at_the_overlap_boundary() {
        // Sweep paragraph lengths so a multi-byte char lands on the cut.
        for pad in 0..12usize {
            let para_a = format!("{}é", "a".repeat(TARGET_CHUNK_CHARS - pad));
            let para_b = "b".repeat(TARGET_CHUNK_CHARS);
            let text = format!("{para_a}\n\n{para_b}");
            let chunks = chunk_text_minimal(&text);
            assert!(!chunks.is_empty(), "pad {pad} produced no chunks");
        }
    }

    #[test]
    fn chunking_survives_text_that_is_entirely_multibyte() {
        let text = format!(
            "{}\n\n{}",
            "日本語のテキストです。".repeat(400),
            "🙂🙃".repeat(400)
        );
        let chunks = chunk_text_minimal(&text);
        assert!(!chunks.is_empty());
        // Every chunk must still be valid UTF-8 that round-trips.
        for c in &chunks {
            assert_eq!(c.as_str(), String::from_utf8_lossy(c.as_bytes()));
        }
    }
    use super::*;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn count_missing_embeddings_matches_list() {
        let conn = mem_conn();
        let prepared = PreparedSource {
            uri: "/tmp/notes.md".into(),
            source_type: "markdown".into(),
            title: "notes".into(),
            content_hash: "notes_hash_v1".into(),
            chunks: vec![
                PreparedChunk {
                    text: "alpha".into(),
                    meta: serde_json::json!({ "contentHash": content_hash(b"alpha") }),
                },
                PreparedChunk {
                    text: "beta".into(),
                    meta: serde_json::json!({ "contentHash": content_hash(b"beta") }),
                },
            ],
        };
        upsert_prepared_source(&conn, &prepared).unwrap();
        let listed = chunks_missing_embeddings(&conn, None).unwrap();
        let counted = count_kb_chunks_missing_embeddings(&conn, None).unwrap();
        assert_eq!(counted as usize, listed.len());
        assert!(counted >= 2);
    }

    #[test]
    fn chunk_text_splits_paragraphs() {
        let text = "para one\n\npara two\n\npara three that is longer";
        let chunks = chunk_text_minimal(text);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().any(|c| c.contains("para one")));
    }

    fn chunk_of(text: &str, title: &str) -> PreparedChunk {
        PreparedChunk {
            text: text.into(),
            meta: serde_json::json!({
                "sourceTitle": title,
                "headingPath": ["H"],
                "contentHash": content_hash(text.as_bytes()),
            }),
        }
    }

    fn stored_indices(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT meta_json FROM kb_chunks").unwrap();
        let mut out: Vec<i64> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|m| {
                serde_json::from_str::<serde_json::Value>(&m.unwrap())
                    .unwrap()
                    .get("index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(-1)
            })
            .collect();
        out.sort_unstable();
        out
    }

    /// A reused chunk kept whatever `index` it was first written with. Insert a
    /// paragraph at the top of a document and every chunk below it reuses its
    /// row, so the stored indices go stale and collide — while
    /// `sortKbChunksForDisplay` (kb-source-view.ts) orders the KB viewer by
    /// exactly that field. Document order silently becomes wrong.
    #[test]
    fn prepared_upsert_refreshes_index_on_reused_chunks() {
        let conn = mem_conn();
        let base = |hash: &str, texts: &[&str]| PreparedSource {
            uri: "/tmp/shift.md".into(),
            source_type: "markdown".into(),
            title: "shift".into(),
            content_hash: hash.into(),
            chunks: texts.iter().map(|s| chunk_of(s, "shift")).collect(),
        };

        upsert_prepared_source(&conn, &base("v1", &["alpha", "bravo", "charlie"])).unwrap();
        assert_eq!(stored_indices(&conn), vec![0, 1, 2]);

        // One new paragraph at the top; the other three are byte-identical and
        // are therefore reused.
        let r = upsert_prepared_source(
            &conn,
            &base("v2", &["inserted", "alpha", "bravo", "charlie"]),
        )
        .unwrap();
        assert_eq!(r.chunk_count, 4);
        assert_eq!(
            stored_indices(&conn),
            vec![0, 1, 2, 3],
            "reused chunks kept stale indices; document order is corrupted"
        );
    }

    /// A row whose `meta_json` is not parseable (a hand edit, a partial
    /// migration) must not be able to abort the whole ingest. It has no
    /// content hash, so it can never be matched for reuse — it is replaced and
    /// the ingest completes, rather than one bad row taking the source down.
    #[test]
    fn prepared_upsert_survives_unparseable_meta_json() {
        let conn = mem_conn();
        let build = |hash: &str, texts: &[&str]| PreparedSource {
            uri: "/tmp/corrupt.md".into(),
            source_type: "markdown".into(),
            title: "corrupt".into(),
            content_hash: hash.into(),
            chunks: texts.iter().map(|s| chunk_of(s, "corrupt")).collect(),
        };
        upsert_prepared_source(&conn, &build("v1", &["alpha", "bravo"])).unwrap();

        // Corrupt one row three ways across two runs: invalid JSON, then a
        // non-object JSON value.
        for corruption in ["not json at all", "[1,2,3]"] {
            conn.execute(
                "UPDATE kb_chunks SET meta_json = ?1 WHERE text = 'alpha'",
                params![corruption],
            )
            .unwrap();

            let r = upsert_prepared_source(&conn, &build("v2", &["alpha", "bravo", "charlie"]))
                .unwrap_or_else(|e| panic!("corrupt meta ({corruption}) aborted the ingest: {e}"));
            assert_eq!(r.chunk_count, 3);
            let n: i64 = conn
                .query_row("SELECT count(*) FROM kb_chunks", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 3, "corrupt row was not replaced cleanly");
            assert_eq!(stored_indices(&conn), vec![0, 1, 2]);
            // reset for the next corruption shape
            conn.execute("UPDATE kb_sources SET content_hash = 'v1'", [])
                .unwrap();
        }
    }

    /// `by_hash` mapped one hash to one id, so a document containing the same
    /// text twice reused a single row for both occurrences and deleted the
    /// others as "stale" — losing chunks on a re-ingest that changed nothing.
    #[test]
    fn prepared_upsert_keeps_duplicate_chunks_distinct() {
        let conn = mem_conn();
        let dup = "a repeated boilerplate paragraph";
        let build = |hash: &str| PreparedSource {
            uri: "/tmp/dup.md".into(),
            source_type: "markdown".into(),
            title: "dup".into(),
            content_hash: hash.into(),
            chunks: vec![
                chunk_of(dup, "dup"),
                chunk_of("unique", "dup"),
                chunk_of(dup, "dup"),
                chunk_of(dup, "dup"),
            ],
        };

        let r1 = upsert_prepared_source(&conn, &build("v1")).unwrap();
        assert_eq!(r1.chunk_count, 4);

        // Same chunks, new source hash: every row must be reused, none dropped.
        let r2 = upsert_prepared_source(&conn, &build("v2")).unwrap();
        assert_eq!(
            r2.chunk_count, 4,
            "duplicate-text chunks collapsed onto one row"
        );
        let n: i64 = conn
            .query_row("SELECT count(*) FROM kb_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 4, "rows were deleted as stale on a no-change re-ingest");
        assert_eq!(stored_indices(&conn), vec![0, 1, 2, 3]);
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

    fn create_boom_trigger(conn: &Connection, exact: bool) {
        let predicate = if exact {
            "NEW.text = 'BOOM'"
        } else {
            "NEW.text LIKE '%BOOM%'"
        };
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_boom AFTER INSERT ON kb_chunks
             WHEN {predicate}
             BEGIN SELECT RAISE(ABORT, 'boom'); END;"
        ))
        .unwrap();
    }

    fn count_rows(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// A mid-loop chunk-insert failure must roll back the source row too. The
    /// previous autocommit path committed the hash-bearing source row first,
    /// so a partial ingest short-circuited every future re-ingest of identical
    /// content as `skipped` forever — self-heal was impossible.
    #[test]
    fn failed_new_source_ingest_leaves_no_source_row() {
        let conn = mem_conn();
        create_boom_trigger(&conn, true);

        let prepared = PreparedSource {
            uri: "/tmp/doom.md".into(),
            source_type: "markdown".into(),
            title: "doom".into(),
            content_hash: "doom_v1".into(),
            chunks: vec![
                chunk_of("alpha", "doom"),
                chunk_of("BOOM", "doom"),
            ],
        };
        let err = upsert_prepared_source(&conn, &prepared).unwrap_err();
        assert!(err.contains("boom"), "unexpected error: {err}");
        assert_eq!(
            count_rows(&conn, "SELECT COUNT(*) FROM kb_sources"),
            0,
            "source row survived a failed ingest"
        );
        assert_eq!(
            count_rows(&conn, "SELECT COUNT(*) FROM kb_chunks"),
            0,
            "chunks from a failed ingest survived"
        );
    }

    /// Same atomicity guarantee for the diff/re-upsert path: a failure between
    /// inserting a new chunk and deleting stale ones must restore the previous
    /// document exactly, including the old source content hash.
    #[test]
    fn failed_diff_ingest_keeps_previous_source_intact() {
        let conn = mem_conn();
        let build = |hash: &str, texts: &[&str]| PreparedSource {
            uri: "/tmp/diff-doom.md".into(),
            source_type: "markdown".into(),
            title: "diff".into(),
            content_hash: hash.into(),
            chunks: texts.iter().map(|s| chunk_of(s, "diff")).collect(),
        };

        upsert_prepared_source(&conn, &build("v1", &["old one", "old two"])).unwrap();
        create_boom_trigger(&conn, true);

        let err =
            upsert_prepared_source(&conn, &build("v2", &["fresh", "BOOM"])).unwrap_err();
        assert!(err.contains("boom"), "unexpected error: {err}");

        assert_eq!(
            count_rows(&conn, "SELECT COUNT(*) FROM kb_chunks"),
            2,
            "partial diff state leaked past the failed upsert"
        );
        let texts: Vec<String> = {
            let mut stmt = conn.prepare("SELECT text FROM kb_chunks").unwrap();
            let mut out: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            out.sort();
            out
        };
        assert_eq!(texts, vec!["old one".to_string(), "old two".to_string()]);
        let hash: String = conn
            .query_row("SELECT content_hash FROM kb_sources LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hash, "v1", "failed upsert still advanced the source hash");
    }

    /// Path-based `ingest_source` gets the same all-or-nothing treatment on
    /// brand-new sources.
    #[test]
    fn failed_path_ingest_leaves_no_partial_state() {
        use std::fs;
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("path-doom.md");
        // Two chunks: a >TARGET_CHUNK_CHARS paragraph, then one containing the
        // trigger marker so the second insert fails.
        fs::write(&file, format!("{}\n\nBOOM", "a".repeat(TARGET_CHUNK_CHARS + 100)))
            .unwrap();

        let conn = mem_conn();
        create_boom_trigger(&conn, false);

        let err = ingest_source(&conn, file.to_str().unwrap(), "markdown").unwrap_err();
        assert!(err.contains("boom"), "unexpected error: {err}");
        assert_eq!(
            count_rows(&conn, "SELECT COUNT(*) FROM kb_sources"),
            0,
            "path ingest left a source row behind"
        );
        assert_eq!(
            count_rows(&conn, "SELECT COUNT(*) FROM kb_chunks"),
            0,
            "path ingest left chunks behind"
        );
    }

    /// A stored row whose text disagrees with its claimed contentHash must not
    /// be reused: the payload wins, the stale body is replaced.
    #[test]
    fn hash_match_with_changed_stored_text_reingests() {
        let conn = mem_conn();
        let build = |hash: &str| PreparedSource {
            uri: "/tmp/stale.md".into(),
            source_type: "markdown".into(),
            title: "stale".into(),
            content_hash: hash.into(),
            chunks: vec![chunk_of("alpha body", "stale")],
        };
        let r1 = upsert_prepared_source(&conn, &build("v1")).unwrap();
        let old_id = r1.chunk_ids[0].clone();

        // Corrupt the stored text while keeping the claimed hash intact.
        conn.execute(
            "UPDATE kb_chunks SET text = 'corrupted body' WHERE id = ?1",
            params![old_id],
        )
        .unwrap();

        let r2 = upsert_prepared_source(&conn, &build("v2")).unwrap();
        assert!(!r2.skipped);
        assert!(
            !r2.chunk_ids.contains(&old_id),
            "reused a row whose text contradicted its hash"
        );
        assert_eq!(count_rows(&conn, "SELECT COUNT(*) FROM kb_chunks"), 1);
        let text: String = conn
            .query_row("SELECT text FROM kb_chunks LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(text, "alpha body");
    }

    /// Embedding existence must be qualified by the active embed model (the
    /// schema PK is `(owner_id, model)`), so switching models flags reused
    /// chunks for re-embedding instead of counting retired-model rows as fresh.
    #[test]
    fn switching_embed_models_flags_reused_chunks_for_reembedding() {
        let _ = super::super::vectors::ensure_sqlite_vec_registered();
        let conn = mem_conn();
        let build = |hash: &str| PreparedSource {
            uri: "/tmp/model-switch.md".into(),
            source_type: "markdown".into(),
            title: "switch".into(),
            content_hash: hash.into(),
            chunks: vec![chunk_of("persistent body", "switch")],
        };
        let r1 = upsert_prepared_source(&conn, &build("v1")).unwrap();
        let chunk_id = r1.chunk_ids[0].clone();
        let emb = |model: &str| super::super::EmbeddingItem {
            owner_id: chunk_id.clone(),
            owner_kind: "chunk".into(),
            model: model.into(),
            vec: vec![1.0, 0.0],
        };

        // Stored under model-a; a re-ingest that reuses the row needs nothing.
        super::super::store_embeddings_blocking(&conn, &[emb("model-a")]).unwrap();
        let r2 = upsert_prepared_source(&conn, &build("v2")).unwrap();
        assert!(
            !r2.needs_embedding.contains(&chunk_id),
            "current-model embedding flagged for re-embed"
        );

        // Switch to model-b *without* re-embedding anything: only the recorded
        // active model moves, and the row's sole embedding is still model-a's.
        super::super::vectors::set_active_embed_model(&conn, "model-b").unwrap();
        let r3 = upsert_prepared_source(&conn, &build("v3")).unwrap();
        assert!(
            r3.needs_embedding.contains(&chunk_id),
            "model switch did not flag the reused chunk for re-embedding"
        );

        // Once model-b coverage lands, the same chunk is current again.
        super::super::store_embeddings_blocking(&conn, &[emb("model-b")]).unwrap();
        let r4 = upsert_prepared_source(&conn, &build("v4")).unwrap();
        assert!(
            !r4.needs_embedding.contains(&chunk_id),
            "current-model embedding flagged after re-embed"
        );
    }

    /// The storage layer enforces the MCP-side caps itself, so the direct
    /// webview command cannot bypass them.
    #[test]
    fn prepared_upsert_enforces_storage_caps() {
        let conn = mem_conn();
        let max_bytes = crate::mcp::tools_career::MAX_TEXT_BYTES;

        let empty = PreparedSource {
            uri: "/tmp/caps-empty.md".into(),
            source_type: "markdown".into(),
            title: "caps".into(),
            content_hash: "h".into(),
            chunks: vec![PreparedChunk {
                text: "   ".into(),
                meta: serde_json::json!({ "contentHash": "x" }),
            }],
        };
        let err = upsert_prepared_source(&conn, &empty).unwrap_err();
        assert!(err.contains("empty"), "got: {err}");

        let oversized = PreparedSource {
            uri: "/tmp/caps-bytes.md".into(),
            source_type: "markdown".into(),
            title: "caps".into(),
            content_hash: "h".into(),
            chunks: vec![PreparedChunk {
                text: "x".repeat(max_bytes + 1),
                meta: serde_json::json!({ "contentHash": "x" }),
            }],
        };
        let err = upsert_prepared_source(&conn, &oversized).unwrap_err();
        assert!(err.contains("byte limit"), "got: {err}");

        let too_many: Vec<PreparedChunk> = (0..=MAX_PREPARED_CHUNKS)
            .map(|i| PreparedChunk {
                text: format!("chunk {i}"),
                meta: serde_json::json!({ "contentHash": format!("h{i}") }),
            })
            .collect();
        let many = PreparedSource {
            uri: "/tmp/caps-count.md".into(),
            source_type: "markdown".into(),
            title: "caps".into(),
            content_hash: "h".into(),
            chunks: too_many,
        };
        let err = upsert_prepared_source(&conn, &many).unwrap_err();
        assert!(err.contains("chunk limit"), "got: {err}");
    }

    /// Deleting an existing KB source removes chunks, embeddings and the
    /// source row together; deleting a missing id mutates nothing.
    #[test]
    fn delete_kb_source_is_atomic_and_strict() {
        let _ = super::super::vectors::ensure_sqlite_vec_registered();
        let conn = mem_conn();
        let prepared = PreparedSource {
            uri: "/tmp/deleteme.md".into(),
            source_type: "markdown".into(),
            title: "deleteme".into(),
            content_hash: "dv1".into(),
            chunks: vec![chunk_of("one", "deleteme"), chunk_of("two", "deleteme")],
        };
        let r = upsert_prepared_source(&conn, &prepared).unwrap();
        let embedded = r.chunk_ids[0].clone();
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, 'chunk', 'm', 2, ?2)",
            params![embedded, vec![0u8, 0, 0, 0, 0, 0, 128, 63]],
        )
        .unwrap();

        delete_kb_source(&conn, &r.source_id).unwrap();
        assert_eq!(count_rows(&conn, "SELECT COUNT(*) FROM kb_sources"), 0);
        assert_eq!(count_rows(&conn, "SELECT COUNT(*) FROM kb_chunks"), 0);
        assert_eq!(
            count_rows(
                &conn,
                &format!("SELECT COUNT(*) FROM embeddings WHERE owner_id = '{embedded}'")
            ),
            0,
            "chunk embedding outlived its source"
        );

        // Orphaned chunk + embedding under a source id that does not exist.
        // The bundled libsqlite3 compiles with SQLITE_DEFAULT_FOREIGN_KEYS=1,
        // so orphans need FK enforcement off — exactly the legacy / corrupted
        // DB state this guard protects against.
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        conn.execute(
            "INSERT INTO kb_chunks (id, source_id, text, meta_json) VALUES ('chk_orph', 'src_none', 'orphan', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES ('chk_orph', 'chunk', 'm', 2, ?1)",
            params![vec![0u8, 0, 0, 0, 0, 0, 128, 63]],
        )
        .unwrap();
        let err = delete_kb_source(&conn, "src_none").unwrap_err();
        assert!(err.contains("KB source not found"), "got: {err}");
        assert_eq!(
            count_rows(&conn, "SELECT COUNT(*) FROM kb_chunks WHERE id = 'chk_orph'"),
            1,
            "failed delete removed orphaned chunks"
        );
        assert_eq!(
            count_rows(
                &conn,
                "SELECT COUNT(*) FROM embeddings WHERE owner_id = 'chk_orph'"
            ),
            1,
            "failed delete removed orphaned embeddings"
        );
    }
}
