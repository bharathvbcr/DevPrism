//! Embedding pack/unpack, sqlite-vec ANN search, and brute-force cosine fallback.

use crate::career_db::schema::{meta_get, meta_set};
use crate::semantic_layer::math::cosine_similarity;
use rusqlite::auto_extension::{register_auto_extension, RawAutoExtension};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sqlite_vec::sqlite3_vec_init;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

const OVERFETCH_FACTOR: usize = 4;
const OVERFETCH_MIN: usize = 32;

static VEC_REGISTER_ONCE: Once = Once::new();
static VEC_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Pack f32 little-endian into a BLOB.
pub fn pack_f32_le(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Unpack f32 little-endian BLOB. Returns error on truncated input.
pub fn unpack_f32_le(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!(
            "Embedding blob length {} is not a multiple of 4",
            bytes.len()
        ));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr: [u8; 4] = chunk
            .try_into()
            .map_err(|_| "Failed to read f32 chunk".to_string())?;
        out.push(f32::from_le_bytes(arr));
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilter {
    pub owner_kind: Option<String>,
    pub personas: Option<Vec<String>>,
    pub domains: Option<Vec<String>>,
    pub kinds: Option<Vec<String>>,
    /// When set, search only this embed model. When omitted, the densest
    /// model matching the query dimension is chosen (one model per query).
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredHit {
    pub owner_id: String,
    pub owner_kind: String,
    pub score: f32,
    pub text: String,
    pub meta: serde_json::Value,
}

struct EmbeddingRow {
    owner_id: String,
    owner_kind: String,
    vec: Vec<f32>,
}

/// Register sqlite-vec once per process. Returns whether the extension works.
pub fn ensure_sqlite_vec_registered() -> bool {
    VEC_REGISTER_ONCE.call_once(|| {
        let ok = (|| -> Result<(), String> {
            unsafe {
                // sqlite3_vec_init has the SQLite extension entrypoint ABI.
                let raw: RawAutoExtension =
                    std::mem::transmute(sqlite3_vec_init as *const () as usize);
                register_auto_extension(raw)
                    .map_err(|e| format!("register_auto_extension failed: {e}"))?;
            }
            let probe = Connection::open_in_memory()
                .map_err(|e| format!("sqlite-vec probe open failed: {e}"))?;
            let version: String = probe
                .query_row("SELECT vec_version()", [], |r| r.get(0))
                .map_err(|e| format!("vec_version() failed: {e}"))?;
            if version.is_empty() {
                return Err("empty vec_version".into());
            }
            Ok(())
        })()
        .map_err(|e| {
            eprintln!("[career_db] sqlite-vec unavailable ({e}); brute-force fallback");
            e
        })
        .is_ok();
        VEC_AVAILABLE.store(ok, Ordering::SeqCst);
    });
    VEC_AVAILABLE.load(Ordering::SeqCst)
}

/// Stable positive rowid for `(owner_id, model)` in `vec_embeddings`.
fn stable_rowid(owner_id: &str, model: &str) -> i64 {
    let mut hasher = DefaultHasher::new();
    owner_id.hash(&mut hasher);
    0u8.hash(&mut hasher);
    model.hash(&mut hasher);
    (hasher.finish() as i64) & i64::MAX
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(|e| format!("Failed to check table {name}: {e}"))?;
    Ok(n > 0)
}

/// Ensure `vec_embeddings` exists for `dim`. Rebuilds from `embeddings` SoT when
/// the indexed dimension changes or the virtual table is missing.
pub fn ensure_vec_embeddings(conn: &Connection, dim: usize) -> Result<(), String> {
    if !ensure_sqlite_vec_registered() {
        return Err("sqlite-vec not available".into());
    }
    if dim == 0 {
        return Err("embedding dim must be > 0".into());
    }

    let current_dim = meta_get(conn, "vec_dim")?
        .and_then(|s| s.parse::<usize>().ok());
    let exists = table_exists(conn, "vec_embeddings")?;
    if exists && current_dim == Some(dim) {
        return Ok(());
    }

    rebuild_vec_embeddings(conn, dim)
}

fn rebuild_vec_embeddings(conn: &Connection, dim: usize) -> Result<(), String> {
    let _ = conn.execute("DROP TABLE IF EXISTS vec_embeddings", []);
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE vec_embeddings USING vec0(
                embedding float[{dim}] distance_metric=cosine,
                model TEXT,
                owner_kind TEXT,
                +owner_id TEXT
            )"
        ),
        [],
    )
    .map_err(|e| format!("Failed to create vec_embeddings: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT owner_id, owner_kind, model, vec FROM embeddings WHERE dim = ?1",
        )
        .map_err(|e| format!("Failed to prepare vec rebuild scan: {e}"))?;
    let rows = stmt
        .query_map(params![dim as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|e| format!("Failed to scan embeddings for vec rebuild: {e}"))?;

    let mut insert = conn
        .prepare(
            "INSERT INTO vec_embeddings(rowid, embedding, model, owner_kind, owner_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|e| format!("Failed to prepare vec insert: {e}"))?;

    for row in rows {
        let (owner_id, owner_kind, model, blob) =
            row.map_err(|e| format!("Failed to read embedding for vec rebuild: {e}"))?;
        // Skip corrupt / wrong-length blobs.
        if blob.len() != dim * 4 {
            continue;
        }
        let rowid = stable_rowid(&owner_id, &model);
        insert
            .execute(params![rowid, blob, model, owner_kind, owner_id])
            .map_err(|e| format!("Failed to insert vec row for {owner_id}: {e}"))?;
    }

    meta_set(conn, "vec_dim", &dim.to_string())?;
    Ok(())
}

/// Upsert one row into the ANN index after writing the `embeddings` SoT row.
pub fn upsert_ann_embedding(
    conn: &Connection,
    owner_id: &str,
    owner_kind: &str,
    model: &str,
    vec: &[f32],
) -> Result<(), String> {
    if !ensure_sqlite_vec_registered() {
        return Ok(());
    }
    let dim = vec.len();
    if dim == 0 {
        return Ok(());
    }
    if let Err(e) = ensure_vec_embeddings(conn, dim) {
        eprintln!("[career_db] ANN upsert skipped ({e})");
        return Ok(());
    }
    let rowid = stable_rowid(owner_id, model);
    let blob = pack_f32_le(vec);
    let _ = conn.execute(
        "DELETE FROM vec_embeddings WHERE rowid = ?1",
        params![rowid],
    );
    match conn.execute(
        "INSERT INTO vec_embeddings(rowid, embedding, model, owner_kind, owner_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![rowid, blob, model, owner_kind, owner_id],
    ) {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("[career_db] ANN insert failed for {owner_id}: {e}");
            Ok(())
        }
    }
}

/// Delete all embedding rows (every model) for an owner, including ANN rows.
pub fn delete_owner_embeddings(conn: &Connection, owner_id: &str) -> Result<(), String> {
    if ensure_sqlite_vec_registered() && table_exists(conn, "vec_embeddings")? {
        let mut stmt = conn
            .prepare("SELECT model FROM embeddings WHERE owner_id = ?1")
            .map_err(|e| format!("Failed to list models for {owner_id}: {e}"))?;
        let models: Vec<String> = stmt
            .query_map(params![owner_id], |r| r.get(0))
            .map_err(|e| format!("Failed to query models for {owner_id}: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read models for {owner_id}: {e}"))?;
        for model in models {
            let rowid = stable_rowid(owner_id, &model);
            let _ = conn.execute(
                "DELETE FROM vec_embeddings WHERE rowid = ?1",
                params![rowid],
            );
        }
    }
    conn.execute(
        "DELETE FROM embeddings WHERE owner_id = ?1",
        params![owner_id],
    )
    .map_err(|e| format!("Failed to delete embeddings for {owner_id}: {e}"))?;
    Ok(())
}

/// Pick the embed model for this query: explicit filter, else densest matching dim.
fn resolve_search_model(
    conn: &Connection,
    dim: usize,
    filter: &SearchFilter,
) -> Result<Option<String>, String> {
    if let Some(ref model) = filter.model {
        if !model.is_empty() {
            return Ok(Some(model.clone()));
        }
    }
    let model: Option<String> = conn
        .query_row(
            "SELECT model FROM embeddings
             WHERE dim = ?1
             GROUP BY model
             ORDER BY COUNT(*) DESC, model ASC
             LIMIT 1",
            params![dim as i64],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to resolve search model: {e}"))?;
    Ok(model)
}

/// Vector search: sqlite-vec KNN when available, else brute-force cosine.
/// Always scoped to a single embed model per query.
pub fn vector_search(
    conn: &Connection,
    query_vec: &[f32],
    k: usize,
    filter: &SearchFilter,
) -> Result<Vec<ScoredHit>, String> {
    if query_vec.is_empty() {
        return Ok(Vec::new());
    }
    let k = k.max(1);
    let model = resolve_search_model(conn, query_vec.len(), filter)?;

    if ensure_sqlite_vec_registered() {
        match vector_search_ann(conn, query_vec, k, filter, model.as_deref()) {
            Ok(hits) => return Ok(hits),
            Err(e) => {
                eprintln!("[career_db] ANN search failed ({e}); brute-force fallback");
            }
        }
    }

    vector_search_brute(conn, query_vec, k, filter, model.as_deref())
}

fn vector_search_ann(
    conn: &Connection,
    query_vec: &[f32],
    k: usize,
    filter: &SearchFilter,
    model: Option<&str>,
) -> Result<Vec<ScoredHit>, String> {
    let dim = query_vec.len();
    ensure_vec_embeddings(conn, dim)?;

    let overfetch = (k.saturating_mul(OVERFETCH_FACTOR)).max(OVERFETCH_MIN);
    let blob = pack_f32_le(query_vec);

    let mut sql = String::from(
        "SELECT owner_id, owner_kind, distance
         FROM vec_embeddings
         WHERE embedding MATCH ?1 AND k = ?2",
    );
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    bind.push(Box::new(blob));
    bind.push(Box::new(overfetch as i64));

    if let Some(m) = model {
        sql.push_str(&format!(" AND model = ?{}", bind.len() + 1));
        bind.push(Box::new(m.to_string()));
    }
    if let Some(ref kind) = filter.owner_kind {
        sql.push_str(&format!(" AND owner_kind = ?{}", bind.len() + 1));
        bind.push(Box::new(kind.clone()));
    }

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare ANN search: {e}"))?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("Failed to run ANN search: {e}"))?;

    let mut hits = Vec::new();
    for row in rows {
        let (owner_id, owner_kind, distance) =
            row.map_err(|e| format!("Failed to read ANN row: {e}"))?;
        if !passes_block_filters(conn, &owner_id, &owner_kind, filter)? {
            continue;
        }
        // Cosine distance → similarity in [0, 2] typically; clamp for display.
        let score = (1.0 - distance as f32).clamp(-1.0, 1.0);
        let (text, meta) = resolve_hit_text(conn, &owner_id, &owner_kind)?;
        hits.push(ScoredHit {
            owner_id,
            owner_kind,
            score,
            text,
            meta,
        });
        if hits.len() >= k {
            break;
        }
    }
    Ok(hits)
}

/// Brute-force cosine search over stored embeddings (fallback / tests).
fn vector_search_brute(
    conn: &Connection,
    query_vec: &[f32],
    k: usize,
    filter: &SearchFilter,
    model: Option<&str>,
) -> Result<Vec<ScoredHit>, String> {
    let mut sql = String::from(
        "SELECT owner_id, owner_kind, vec FROM embeddings WHERE dim = ?1",
    );
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    bind.push(Box::new(query_vec.len() as i64));

    if let Some(m) = model {
        sql.push_str(&format!(" AND model = ?{}", bind.len() + 1));
        bind.push(Box::new(m.to_string()));
    }
    if let Some(ref kind) = filter.owner_kind {
        sql.push_str(&format!(" AND owner_kind = ?{}", bind.len() + 1));
        bind.push(Box::new(kind.clone()));
    }

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare vector search: {e}"))?;

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            let owner_id: String = row.get(0)?;
            let owner_kind: String = row.get(1)?;
            let blob: Vec<u8> = row.get(2)?;
            Ok((owner_id, owner_kind, blob))
        })
        .map_err(|e| format!("Failed to query embeddings: {e}"))?;

    let mut candidates: Vec<EmbeddingRow> = Vec::new();
    for row in rows {
        let (owner_id, owner_kind, blob) =
            row.map_err(|e| format!("Failed to read embedding row: {e}"))?;
        let vec = unpack_f32_le(&blob)?;
        if vec.len() != query_vec.len() {
            continue;
        }
        if !passes_block_filters(conn, &owner_id, &owner_kind, filter)? {
            continue;
        }
        candidates.push(EmbeddingRow {
            owner_id,
            owner_kind,
            vec,
        });
    }

    let mut scored: Vec<(f32, EmbeddingRow)> = candidates
        .into_iter()
        .map(|row| {
            let score = cosine_similarity(query_vec, &row.vec);
            (score, row)
        })
        .collect();
    // `total_cmp` rather than `partial_cmp(...).unwrap_or(Equal)`.
    //
    // Mapping NaN to `Equal` is an intransitive comparator, and since Rust 1.81
    // the standard sort detects order violations and may panic outright with
    // "user-provided comparison function does not correctly implement a total
    // order"; where it does not panic, the ranking is simply garbage. NaN reaches
    // here whenever a stored vector holds a non-finite component (a corrupt BLOB,
    // or a frontend-supplied `1e40` that becomes `inf` on the `as f32` cast),
    // because `cosine_similarity` guards only the zero-norm case.
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.truncate(k);

    let mut hits = Vec::with_capacity(scored.len());
    for (score, row) in scored {
        let (text, meta) = resolve_hit_text(conn, &row.owner_id, &row.owner_kind)?;
        hits.push(ScoredHit {
            owner_id: row.owner_id,
            owner_kind: row.owner_kind,
            score,
            text,
            meta,
        });
    }
    Ok(hits)
}

fn passes_block_filters(
    conn: &Connection,
    owner_id: &str,
    owner_kind: &str,
    filter: &SearchFilter,
) -> Result<bool, String> {
    let needs_block =
        filter.personas.is_some() || filter.domains.is_some() || filter.kinds.is_some();
    if !needs_block {
        return Ok(true);
    }
    // Persona/domain/kind filters apply to experience blocks only.
    if owner_kind != "block" {
        return Ok(false);
    }

    let json: String = match conn.query_row(
        "SELECT json FROM blocks WHERE id = ?1",
        params![owner_id],
        |r| r.get(0),
    ) {
        Ok(j) => j,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(false),
        Err(e) => {
            return Err(format!("Failed to load block {owner_id} for filter: {e}"));
        }
    };

    let value: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Invalid block JSON for {owner_id}: {e}"))?;

    if let Some(ref kinds) = filter.kinds {
        let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if !kinds.iter().any(|k| k == kind) {
            return Ok(false);
        }
    }
    if let Some(ref personas) = filter.personas {
        let block_personas = value
            .get("personas")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        if !personas
            .iter()
            .any(|p| block_personas.contains(&p.as_str()))
        {
            return Ok(false);
        }
    }
    if let Some(ref domains) = filter.domains {
        let block_domains = value
            .get("domains")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        if !domains.iter().any(|d| block_domains.contains(&d.as_str())) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn resolve_hit_text(
    conn: &Connection,
    owner_id: &str,
    owner_kind: &str,
) -> Result<(String, serde_json::Value), String> {
    match owner_kind {
        "chunk" => {
            let (text, meta_json): (String, Option<String>) = conn
                .query_row(
                    "SELECT text, meta_json FROM kb_chunks WHERE id = ?1",
                    params![owner_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| format!("Failed to load chunk {owner_id}: {e}"))?;
            let meta = meta_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Null);
            Ok((text, meta))
        }
        "block" => {
            let json: String = conn
                .query_row(
                    "SELECT json FROM blocks WHERE id = ?1",
                    params![owner_id],
                    |r| r.get(0),
                )
                .map_err(|e| format!("Failed to load block {owner_id}: {e}"))?;
            let value: serde_json::Value = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid block JSON for {owner_id}: {e}"))?;
            let text = value
                .get("embeddingText")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| {
                    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    let org = value.get("org").and_then(|v| v.as_str()).unwrap_or("");
                    Some(format!("{title} {org}").trim().to_string())
                })
                .unwrap_or_default();
            Ok((text, value))
        }
        "bullet" => resolve_bullet_hit(conn, owner_id),
        "fact" => resolve_fact_hit(conn, owner_id),
        _ => Ok((String::new(), serde_json::Value::Null)),
    }
}

fn resolve_child_hit(
    conn: &Connection,
    child_id: &str,
    array_path: &str,
    text_field: &str,
    meta_key: &str,
) -> Result<(String, serde_json::Value), String> {
    let json: Option<String> = conn
        .query_row(
            &format!(
                r#"SELECT json FROM blocks
               WHERE EXISTS (
                 SELECT 1 FROM json_each(json_extract(blocks.json, '{array_path}')) AS c
                 WHERE json_extract(c.value, '$.id') = ?1
               )
               LIMIT 1"#
            ),
            params![child_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| {
            format!("Failed to find parent block for {meta_key} {child_id}: {e}")
        })?;

    let Some(json) = json else {
        return Ok((String::new(), serde_json::Value::Null));
    };

    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| {
        format!("Invalid block JSON while resolving {meta_key} {child_id}: {e}")
    })?;

    let child = value
        .get(array_path.trim_start_matches("$."))
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(child_id))
                .cloned()
        });

    let text = child
        .as_ref()
        .and_then(|b| b.get(text_field).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    let meta = serde_json::json!({
        "blockId": value.get("id"),
        "title": value.get("title"),
        "org": value.get("org"),
        "kind": value.get("kind"),
        "personas": value.get("personas"),
        "domains": value.get("domains"),
        meta_key: child.unwrap_or(serde_json::Value::Null),
    });

    Ok((text, meta))
}

fn resolve_bullet_hit(
    conn: &Connection,
    bullet_id: &str,
) -> Result<(String, serde_json::Value), String> {
    resolve_child_hit(conn, bullet_id, "$.bullets", "canonical", "bullet")
}

fn resolve_fact_hit(
    conn: &Connection,
    fact_id: &str,
) -> Result<(String, serde_json::Value), String> {
    resolve_child_hit(conn, fact_id, "$.facts", "text", "fact")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::career_db::schema::{init_schema, seed_default_personas};

    #[test]
    fn pack_unpack_roundtrip() {
        let v = vec![0.1f32, -2.5, 3.0];
        let bytes = pack_f32_le(&v);
        let back = unpack_f32_le(&bytes).unwrap();
        assert_eq!(back.len(), 3);
        assert!((back[0] - 0.1).abs() < 1e-6);
        assert!((back[1] + 2.5).abs() < 1e-6);
    }

    #[test]
    fn vector_search_ranks_by_cosine() {
        let _ = ensure_sqlite_vec_registered();
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        seed_default_personas(&conn).unwrap();

        conn.execute(
            "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, 0)",
            params![
                "exp_a",
                "experience",
                r#"{"id":"exp_a","kind":"experience","title":"ML Eng","org":"Acme","dateRange":{"start":"2020-01","end":null},"personas":["ai"],"domains":["mlops"],"skills":[],"seniorityLevel":"senior","bullets":[],"updatedAt":"2020-01-01T00:00:00Z"}"#
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, 0)",
            params![
                "exp_b",
                "experience",
                r#"{"id":"exp_b","kind":"experience","title":"Bioinfo","org":"Lab","dateRange":{"start":"2020-01","end":null},"personas":["life-sciences"],"domains":["genomics"],"skills":[],"seniorityLevel":"senior","bullets":[],"updatedAt":"2020-01-01T00:00:00Z"}"#
            ],
        )
        .unwrap();

        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["exp_a", "block", "test", 3, pack_f32_le(&a)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["exp_b", "block", "test", 3, pack_f32_le(&b)],
        )
        .unwrap();

        let hits = vector_search(
            &conn,
            &[1.0, 0.0, 0.0],
            2,
            &SearchFilter {
                owner_kind: Some("block".into()),
                model: Some("test".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].owner_id, "exp_a");
        assert!(hits[0].score > hits[1].score);

        let filtered = vector_search(
            &conn,
            &[1.0, 0.0, 0.0],
            5,
            &SearchFilter {
                owner_kind: Some("block".into()),
                personas: Some(vec!["life-sciences".into()]),
                model: Some("test".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].owner_id, "exp_b");
    }

    #[test]
    fn resolve_bullet_hit_text() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, 0)",
            params![
                "exp_1",
                "experience",
                r#"{"id":"exp_1","kind":"experience","title":"Eng","org":"Acme","dateRange":{"start":"2020-01","end":null},"personas":["ai"],"domains":[],"skills":[],"seniorityLevel":"senior","bullets":[{"id":"b1","canonical":"Shipped X","variants":{},"metrics":[],"evidenceRefs":[],"locked":false}],"updatedAt":"2020-01-01T00:00:00Z"}"#
            ],
        )
        .unwrap();

        let (text, meta) = resolve_hit_text(&conn, "b1", "bullet").unwrap();
        assert_eq!(text, "Shipped X");
        assert_eq!(meta.get("blockId").and_then(|v| v.as_str()), Some("exp_1"));
        assert_eq!(meta.get("title").and_then(|v| v.as_str()), Some("Eng"));
    }

    #[test]
    fn resolve_fact_hit_text() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, 0)",
            params![
                "exp_1",
                "experience",
                r#"{"id":"exp_1","kind":"experience","title":"Eng","org":"Acme","dateRange":{"start":"2020-01","end":null},"personas":["ai"],"domains":[],"skills":[],"seniorityLevel":"senior","bullets":[],"facts":[{"id":"f1","text":"Cut latency 40%","skills":["latency"],"metrics":[{"value":"40%","kind":"improvement"}],"source":"manual","createdAt":"2020-01-01T00:00:00Z"}],"updatedAt":"2020-01-01T00:00:00Z"}"#
            ],
        )
        .unwrap();

        let (text, meta) = resolve_hit_text(&conn, "f1", "fact").unwrap();
        assert_eq!(text, "Cut latency 40%");
        assert_eq!(meta.get("blockId").and_then(|v| v.as_str()), Some("exp_1"));
        assert_eq!(meta.get("title").and_then(|v| v.as_str()), Some("Eng"));
        assert_eq!(
            meta.get("fact")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str()),
            Some("Cut latency 40%")
        );
    }

    #[test]
    fn search_scopes_to_one_model() {
        let _ = ensure_sqlite_vec_registered();
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, 0)",
            params![
                "exp_a",
                "experience",
                r#"{"id":"exp_a","kind":"experience","title":"A","org":"O","dateRange":{"start":"2020-01","end":null},"personas":[],"domains":[],"skills":[],"seniorityLevel":"senior","bullets":[],"updatedAt":"2020-01-01T00:00:00Z"}"#
            ],
        )
        .unwrap();

        let v = vec![1.0f32, 0.0];
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["exp_a", "block", "model-a", 2, pack_f32_le(&v)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["exp_a", "block", "model-b", 2, pack_f32_le(&v)],
        )
        .unwrap();

        // Without explicit model, densest/first model wins — still one model.
        let hits = vector_search(
            &conn,
            &[1.0, 0.0],
            5,
            &SearchFilter {
                owner_kind: Some("block".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);

        let hits_b = vector_search(
            &conn,
            &[1.0, 0.0],
            5,
            &SearchFilter {
                owner_kind: Some("block".into()),
                model: Some("model-b".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hits_b.len(), 1);
    }
}
