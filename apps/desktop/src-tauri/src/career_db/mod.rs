//! Persistent Master Career Database (SQLite + sqlite-vec ANN, brute-force fallback).
//!
//! DB path: `dirs::config_dir()/DevPrism/career.db`

mod ingest;
mod schema;
mod vectors;

use ingest::{IngestReport, KbChunkRow, KbSourceRow, PreparedSource};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use vectors::{ScoredHit, SearchFilter};

// --- Domain types (camelCase JSON, mirrored in apps/desktop/src/lib/career/types.ts) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub start: String,
    pub end: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTag {
    pub name: String,
    pub level: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub years: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulletMetric {
    pub value: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bullet {
    pub id: String,
    pub canonical: String,
    #[serde(default)]
    pub variants: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub metrics: Vec<BulletMetric>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockFact {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub metrics: Vec<BulletMetric>,
    #[serde(default = "default_fact_source")]
    pub source: String,
    pub created_at: String,
}

fn default_fact_source() -> String {
    "manual".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceBlock {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub org: String,
    pub date_range: DateRange,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub skills: Vec<SkillTag>,
    pub seniority_level: String,
    #[serde(default)]
    pub bullets: Vec<Bullet>,
    /// Raw knowledge pool for JD-tailored distillation.
    #[serde(default)]
    pub facts: Vec<BlockFact>,
    /// Free-form scratchpad; distill input for AI fact extraction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_text: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Persona {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub skill_weights: serde_json::Map<String, serde_json::Value>,
    pub default_template_id: String,
    #[serde(default)]
    pub section_order: Vec<String>,
    pub tone_directive: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingItem {
    pub owner_id: String,
    pub owner_kind: String,
    pub model: String,
    pub vec: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisRun {
    pub id: String,
    pub jd_hash: String,
    pub persona_id: String,
    pub template_id: String,
    pub report_json: serde_json::Value,
    pub created_at: i64,
}

// --- Managed state ---

enum DbSlot {
    Ready(Connection),
    Failed(String),
}

#[derive(Clone)]
pub struct CareerDbState {
    inner: Arc<Mutex<DbSlot>>,
}

impl Default for CareerDbState {
    fn default() -> Self {
        Self::open_default()
    }
}

impl CareerDbState {
    pub fn open_default() -> Self {
        match open_connection() {
            Ok(conn) => Self {
                inner: Arc::new(Mutex::new(DbSlot::Ready(conn))),
            },
            Err(e) => {
                eprintln!("[career_db] failed to open career.db: {e}");
                Self {
                    inner: Arc::new(Mutex::new(DbSlot::Failed(e))),
                }
            }
        }
    }

    fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let guard = self
            .inner
            .lock()
            .map_err(|e| format!("career db lock poisoned: {e}"))?;
        match &*guard {
            DbSlot::Ready(conn) => f(conn),
            DbSlot::Failed(err) => Err(format!("career db unavailable: {err}")),
        }
    }
}

fn db_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "Could not resolve config dir.".to_string())?;
    Ok(base.join("DevPrism").join("career.db"))
}

fn open_connection() -> Result<Connection, String> {
    // Register sqlite-vec before opening so auto-extension attaches on this conn.
    let _ = vectors::ensure_sqlite_vec_registered();

    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create DevPrism config dir: {e}"))?;
    }
    let conn =
        Connection::open(&path).map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
    schema::init_schema(&conn)?;
    schema::seed_default_personas(&conn)?;
    Ok(conn)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_updated_at_ms(updated_at: &str) -> i64 {
    // Accept ISO-ish strings; fall back to now.
    if let Ok(n) = updated_at.parse::<i64>() {
        return n;
    }
    now_ms()
}

// --- Blocking helpers ---

fn list_blocks_blocking(
    conn: &Connection,
    missing_embeddings_only: bool,
) -> Result<Vec<ExperienceBlock>, String> {
    // EXISTS avoids duplicate rows when multiple (owner_id, model) embeddings exist.
    let sql = if missing_embeddings_only {
        "SELECT b.json FROM blocks b
         WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.owner_id = b.id)
         ORDER BY b.updated_at DESC"
    } else {
        "SELECT json FROM blocks ORDER BY updated_at DESC"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare list blocks: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query blocks: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let json = row.map_err(|e| format!("Failed to read block row: {e}"))?;
        let block: ExperienceBlock =
            serde_json::from_str(&json).map_err(|e| format!("Invalid block JSON in db: {e}"))?;
        out.push(block);
    }
    Ok(out)
}

fn upsert_block_blocking(conn: &Connection, block: &ExperienceBlock) -> Result<(), String> {
    let json =
        serde_json::to_string(block).map_err(|e| format!("Failed to serialize block: {e}"))?;
    let updated_at = parse_updated_at_ms(&block.updated_at);
    conn.execute(
        "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, json = excluded.json, updated_at = excluded.updated_at",
        params![block.id, block.kind, json, updated_at],
    )
    .map_err(|e| format!("Failed to upsert block: {e}"))?;
    Ok(())
}

fn delete_block_blocking(conn: &Connection, id: &str) -> Result<(), String> {
    // Collect child bullet + fact ids from block JSON before deleting the row.
    let block_json: Option<String> = conn
        .query_row(
            "SELECT json FROM blocks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to load block {id} before delete: {e}"))?;

    let mut owner_ids = vec![id.to_string()];
    if let Some(json) = block_json.as_deref() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(bullets) = value.get("bullets").and_then(|v| v.as_array()) {
                for bullet in bullets {
                    if let Some(bid) = bullet.get("id").and_then(|v| v.as_str()) {
                        if !bid.is_empty() {
                            owner_ids.push(bid.to_string());
                        }
                    }
                }
            }
            if let Some(facts) = value.get("facts").and_then(|v| v.as_array()) {
                for fact in facts {
                    if let Some(fid) = fact.get("id").and_then(|v| v.as_str()) {
                        if !fid.is_empty() {
                            owner_ids.push(fid.to_string());
                        }
                    }
                }
            }
        }
    }

    for owner_id in &owner_ids {
        vectors::delete_owner_embeddings(conn, owner_id)?;
    }

    let n = conn
        .execute("DELETE FROM blocks WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete block: {e}"))?;
    if n == 0 {
        return Err(format!("Block not found: {id}"));
    }
    Ok(())
}

fn list_personas_blocking(conn: &Connection) -> Result<Vec<Persona>, String> {
    let mut stmt = conn
        .prepare("SELECT json FROM personas ORDER BY id ASC")
        .map_err(|e| format!("Failed to prepare list personas: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query personas: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let json = row.map_err(|e| format!("Failed to read persona row: {e}"))?;
        let persona: Persona =
            serde_json::from_str(&json).map_err(|e| format!("Invalid persona JSON in db: {e}"))?;
        out.push(persona);
    }
    Ok(out)
}

fn upsert_persona_blocking(conn: &Connection, persona: &Persona) -> Result<(), String> {
    let json =
        serde_json::to_string(persona).map_err(|e| format!("Failed to serialize persona: {e}"))?;
    conn.execute(
        "INSERT INTO personas (id, json) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![persona.id, json],
    )
    .map_err(|e| format!("Failed to upsert persona: {e}"))?;
    Ok(())
}

/// Built-in persona ids from `schema::seed_default_personas`. Not deletable.
const SEEDED_PERSONA_IDS: &[&str] = &["ai", "life-sciences", "management"];

fn is_seeded_persona_id(id: &str) -> bool {
    SEEDED_PERSONA_IDS.iter().any(|s| *s == id)
}

fn delete_persona_blocking(conn: &Connection, id: &str) -> Result<(), String> {
    if is_seeded_persona_id(id) {
        return Err(format!(
            "Cannot delete built-in persona '{id}'. Create a custom persona instead."
        ));
    }
    let n = conn
        .execute("DELETE FROM personas WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete persona: {e}"))?;
    if n == 0 {
        return Err(format!("Persona not found: {id}"));
    }
    Ok(())
}

fn store_embeddings_blocking(conn: &Connection, items: &[EmbeddingItem]) -> Result<(), String> {
    for item in items {
        let blob = vectors::pack_f32_le(&item.vec);
        let dim = item.vec.len() as i64;
        let model = if item.model.trim().is_empty() {
            "unknown"
        } else {
            item.model.as_str()
        };
        conn.execute(
            "INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(owner_id, model) DO UPDATE SET
               owner_kind = excluded.owner_kind,
               dim = excluded.dim,
               vec = excluded.vec",
            params![item.owner_id, item.owner_kind, model, dim, blob],
        )
        .map_err(|e| format!("Failed to store embedding for {}: {e}", item.owner_id))?;
        // Keep ANN index in sync; soft-fails if sqlite-vec is unavailable.
        vectors::upsert_ann_embedding(
            conn,
            &item.owner_id,
            &item.owner_kind,
            model,
            &item.vec,
        )?;
    }
    Ok(())
}

fn save_run_blocking(conn: &Connection, run: &SynthesisRun) -> Result<(), String> {
    let report = serde_json::to_string(&run.report_json)
        .map_err(|e| format!("Failed to serialize run report: {e}"))?;
    let created_at = if run.created_at > 0 {
        run.created_at
    } else {
        now_ms()
    };
    conn.execute(
        "INSERT INTO synthesis_runs (id, jd_hash, persona_id, template_id, report_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           jd_hash = excluded.jd_hash,
           persona_id = excluded.persona_id,
           template_id = excluded.template_id,
           report_json = excluded.report_json,
           created_at = excluded.created_at",
        params![
            run.id,
            run.jd_hash,
            run.persona_id,
            run.template_id,
            report,
            created_at
        ],
    )
    .map_err(|e| format!("Failed to save synthesis run: {e}"))?;
    Ok(())
}

fn list_runs_blocking(conn: &Connection) -> Result<Vec<SynthesisRun>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, jd_hash, persona_id, template_id, report_json, created_at
             FROM synthesis_runs ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare list runs: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| format!("Failed to query runs: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, jd_hash, persona_id, template_id, report, created_at) =
            row.map_err(|e| format!("Failed to read run row: {e}"))?;
        let report_json: serde_json::Value =
            serde_json::from_str(&report).unwrap_or(serde_json::Value::Null);
        out.push(SynthesisRun {
            id,
            jd_hash,
            persona_id,
            template_id,
            report_json,
            created_at,
        });
    }
    Ok(out)
}

// --- Tauri commands ---

#[tauri::command]
pub async fn career_list_blocks(
    state: tauri::State<'_, CareerDbState>,
    missing_embeddings_only: Option<bool>,
) -> Result<Vec<ExperienceBlock>, String> {
    let state = state.inner().clone();
    let missing = missing_embeddings_only.unwrap_or(false);
    tokio::task::spawn_blocking(move || state.with_conn(|c| list_blocks_blocking(c, missing)))
        .await
        .map_err(|e| format!("career_list_blocks task failed: {e}"))?
}

#[tauri::command]
pub async fn career_upsert_block(
    state: tauri::State<'_, CareerDbState>,
    block: ExperienceBlock,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(|c| upsert_block_blocking(c, &block)))
        .await
        .map_err(|e| format!("career_upsert_block task failed: {e}"))?
}

#[tauri::command]
pub async fn career_delete_block(
    state: tauri::State<'_, CareerDbState>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(|c| delete_block_blocking(c, &id)))
        .await
        .map_err(|e| format!("career_delete_block task failed: {e}"))?
}

#[tauri::command]
pub async fn career_list_personas(
    state: tauri::State<'_, CareerDbState>,
) -> Result<Vec<Persona>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(list_personas_blocking))
        .await
        .map_err(|e| format!("career_list_personas task failed: {e}"))?
}

#[tauri::command]
pub async fn career_upsert_persona(
    state: tauri::State<'_, CareerDbState>,
    persona: Persona,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(|c| upsert_persona_blocking(c, &persona)))
        .await
        .map_err(|e| format!("career_upsert_persona task failed: {e}"))?
}

#[tauri::command]
pub async fn career_delete_persona(
    state: tauri::State<'_, CareerDbState>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(|c| delete_persona_blocking(c, &id)))
        .await
        .map_err(|e| format!("career_delete_persona task failed: {e}"))?
}

#[tauri::command]
pub async fn career_ingest_source(
    state: tauri::State<'_, CareerDbState>,
    path: String,
    source_type: String,
) -> Result<IngestReport, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| ingest::ingest_source(c, &path, &source_type))
    })
    .await
    .map_err(|e| format!("career_ingest_source task failed: {e}"))?
}

/// Upsert frontend-prepared chunks (heading-aware markdown/PDF/OPML).
/// Unchanged `meta.contentHash` values reuse chunk ids and embeddings.
#[tauri::command]
pub async fn career_upsert_kb_source(
    state: tauri::State<'_, CareerDbState>,
    prepared: PreparedSource,
) -> Result<IngestReport, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| ingest::upsert_prepared_source(c, &prepared))
    })
    .await
    .map_err(|e| format!("career_upsert_kb_source task failed: {e}"))?
}

#[tauri::command]
pub async fn career_list_kb_sources(
    state: tauri::State<'_, CareerDbState>,
) -> Result<Vec<KbSourceRow>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(ingest::list_kb_sources))
        .await
        .map_err(|e| format!("career_list_kb_sources task failed: {e}"))?
}

#[tauri::command]
pub async fn career_list_kb_chunks(
    state: tauri::State<'_, CareerDbState>,
    source_id: Option<String>,
    missing_embeddings_only: Option<bool>,
) -> Result<Vec<KbChunkRow>, String> {
    let state = state.inner().clone();
    let missing = missing_embeddings_only.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| ingest::list_kb_chunks(c, source_id.as_deref(), missing))
    })
    .await
    .map_err(|e| format!("career_list_kb_chunks task failed: {e}"))?
}

/// Count of KB chunks with no embedding row (for readiness / badges).
#[tauri::command]
pub async fn career_count_kb_chunks_missing_embeddings(
    state: tauri::State<'_, CareerDbState>,
    source_id: Option<String>,
) -> Result<u32, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| {
            ingest::count_kb_chunks_missing_embeddings(c, source_id.as_deref())
        })
    })
    .await
    .map_err(|e| format!("career_count_kb_chunks_missing_embeddings task failed: {e}"))?
}

#[tauri::command]
pub async fn career_delete_kb_source(
    state: tauri::State<'_, CareerDbState>,
    source_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| ingest::delete_kb_source(c, &source_id))
    })
    .await
    .map_err(|e| format!("career_delete_kb_source task failed: {e}"))?
}

#[tauri::command]
pub async fn career_store_embeddings(
    state: tauri::State<'_, CareerDbState>,
    items: Vec<EmbeddingItem>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(|c| store_embeddings_blocking(c, &items)))
        .await
        .map_err(|e| format!("career_store_embeddings task failed: {e}"))?
}

#[tauri::command]
pub async fn career_vector_search(
    state: tauri::State<'_, CareerDbState>,
    query_vec: Vec<f32>,
    k: usize,
    filter: Option<SearchFilter>,
) -> Result<Vec<ScoredHit>, String> {
    let state = state.inner().clone();
    let filter = filter.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| vectors::vector_search(c, &query_vec, k, &filter))
    })
    .await
    .map_err(|e| format!("career_vector_search task failed: {e}"))?
}

#[tauri::command]
pub async fn career_save_run(
    state: tauri::State<'_, CareerDbState>,
    run: SynthesisRun,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(|c| save_run_blocking(c, &run)))
        .await
        .map_err(|e| format!("career_save_run task failed: {e}"))?
}

#[tauri::command]
pub async fn career_list_runs(
    state: tauri::State<'_, CareerDbState>,
) -> Result<Vec<SynthesisRun>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(list_runs_blocking))
        .await
        .map_err(|e| format!("career_list_runs task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> CareerDbState {
        let conn = Connection::open_in_memory().unwrap();
        schema::init_schema(&conn).unwrap();
        schema::seed_default_personas(&conn).unwrap();
        CareerDbState {
            inner: Arc::new(Mutex::new(DbSlot::Ready(conn))),
        }
    }

    #[test]
    fn block_crud_and_personas_seeded() {
        let state = test_state();
        let personas = state.with_conn(list_personas_blocking).unwrap();
        assert_eq!(personas.len(), 3);
        assert!(personas.iter().any(|p| p.id == "ai"));
        assert!(personas.iter().any(|p| p.id == "life-sciences"));
        assert!(personas.iter().any(|p| p.id == "management"));

        let block = ExperienceBlock {
            id: "exp_1".into(),
            kind: "experience".into(),
            title: "Engineer".into(),
            org: "Acme".into(),
            date_range: DateRange {
                start: "2021-03".into(),
                end: None,
            },
            personas: vec!["ai".into()],
            domains: vec!["mlops".into()],
            skills: vec![SkillTag {
                name: "python".into(),
                level: 4,
                years: Some(5.0),
            }],
            seniority_level: "senior".into(),
            bullets: vec![Bullet {
                id: "b1".into(),
                canonical: "Built X".into(),
                variants: serde_json::Map::new(),
                metrics: vec![],
                evidence_refs: vec![],
                locked: false,
            }],
            facts: vec![],
            notes: None,
            embedding_text: Some("Engineer Acme mlops Built X".into()),
            updated_at: "1700000000000".into(),
        };
        state
            .with_conn(|c| upsert_block_blocking(c, &block))
            .unwrap();
        let listed = state
            .with_conn(|c| list_blocks_blocking(c, false))
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Engineer");
        let missing = state
            .with_conn(|c| list_blocks_blocking(c, true))
            .unwrap();
        assert_eq!(missing.len(), 1);
        state
            .with_conn(|c| delete_block_blocking(c, "exp_1"))
            .unwrap();
        assert!(
            state
                .with_conn(|c| list_blocks_blocking(c, false))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn delete_persona_guards_seeded_allows_custom() {
        let state = test_state();
        let err = state
            .with_conn(|c| delete_persona_blocking(c, "ai"))
            .unwrap_err();
        assert!(err.contains("built-in"));

        let custom = Persona {
            id: "custom_ops".into(),
            label: "Ops".into(),
            skill_weights: serde_json::Map::new(),
            default_template_id: "ats-single-column".into(),
            section_order: vec!["experience".into()],
            tone_directive: "".into(),
        };
        state
            .with_conn(|c| upsert_persona_blocking(c, &custom))
            .unwrap();
        state
            .with_conn(|c| delete_persona_blocking(c, "custom_ops"))
            .unwrap();
        let personas = state.with_conn(list_personas_blocking).unwrap();
        assert!(!personas.iter().any(|p| p.id == "custom_ops"));
        assert_eq!(personas.len(), 3);
    }

    #[test]
    fn delete_block_removes_bullet_and_fact_embeddings() {
        let _ = vectors::ensure_sqlite_vec_registered();
        let state = test_state();
        let block = ExperienceBlock {
            id: "exp_del".into(),
            kind: "experience".into(),
            title: "Eng".into(),
            org: "Acme".into(),
            date_range: DateRange {
                start: "2021-03".into(),
                end: None,
            },
            personas: vec!["ai".into()],
            domains: vec![],
            skills: vec![],
            seniority_level: "senior".into(),
            bullets: vec![Bullet {
                id: "bullet_orphan".into(),
                canonical: "Built Y".into(),
                variants: serde_json::Map::new(),
                metrics: vec![],
                evidence_refs: vec![],
                locked: false,
            }],
            facts: vec![BlockFact {
                id: "fact_orphan".into(),
                text: "Raw point about Y".into(),
                skills: vec![],
                metrics: vec![],
                source: "manual".into(),
                created_at: "1700000000000".into(),
            }],
            notes: None,
            embedding_text: Some("Eng Acme Built Y".into()),
            updated_at: "1700000000000".into(),
        };
        state
            .with_conn(|c| upsert_block_blocking(c, &block))
            .unwrap();
        state
            .with_conn(|c| {
                store_embeddings_blocking(
                    c,
                    &[
                        EmbeddingItem {
                            owner_id: "exp_del".into(),
                            owner_kind: "block".into(),
                            model: "test".into(),
                            vec: vec![1.0, 0.0],
                        },
                        EmbeddingItem {
                            owner_id: "bullet_orphan".into(),
                            owner_kind: "bullet".into(),
                            model: "test".into(),
                            vec: vec![0.0, 1.0],
                        },
                        EmbeddingItem {
                            owner_id: "fact_orphan".into(),
                            owner_kind: "fact".into(),
                            model: "test".into(),
                            vec: vec![0.5, 0.5],
                        },
                    ],
                )
            })
            .unwrap();

        state
            .with_conn(|c| delete_block_blocking(c, "exp_del"))
            .unwrap();

        let remaining: i64 = state
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM embeddings WHERE owner_id IN ('exp_del', 'bullet_orphan', 'fact_orphan')",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
