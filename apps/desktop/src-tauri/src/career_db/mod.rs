//! Persistent Master Career Database (SQLite + sqlite-vec ANN, brute-force fallback).
//!
//! DB path: `dirs::config_dir()/DevPrism/career.db`

pub(crate) mod ingest;
pub(crate) mod schema;
pub(crate) mod vectors;

use ingest::{IngestReport, KbChunkRow, KbSourceRow, PreparedSource};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
pub(crate) use vectors::{ScoredHit, SearchFilter};

/// Tauri event emitted whenever another connection (in-app MCP server,
/// `--mcp-stdio` process) commits to `career.db`. Career surfaces refetch on it.
pub const CAREER_DB_CHANGED_EVENT: &str = "career-db-changed";

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
    /// City / region shown on the entry's second line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Optional link for the org name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Display text for `url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_label: Option<String>,
    /// Trailing detail line: GPA, honors, coursework, awards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
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
    #[serde(default, alias = "skillWeights")]
    pub skill_weights: serde_json::Map<String, serde_json::Value>,
    #[serde(alias = "defaultTemplateId")]
    pub default_template_id: String,
    #[serde(default, alias = "sectionOrder")]
    pub section_order: Vec<String>,
    #[serde(alias = "toneDirective")]
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

    /// A private, in-memory career database with the schema and default
    /// personas already applied.
    ///
    /// `open_default` resolves to the user's real `career.db` under their
    /// config directory, so any test built on it both depends on whatever the
    /// user happens to have stored and — for tests that upsert or delete —
    /// mutates their actual career data. Tests must use this instead: each call
    /// is an isolated database that dies with the connection.
    pub fn open_in_memory() -> Result<Self, String> {
        let _ = vectors::ensure_sqlite_vec_registered();
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory career db: {e}"))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
        schema::init_schema(&conn)?;
        schema::seed_default_personas(&conn)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(DbSlot::Ready(conn))),
        })
    }

    /// A state whose every `with_conn` call fails, for exercising the
    /// db-unavailable branch that production hits when `career.db` cannot open.
    #[cfg(test)]
    pub fn failed_for_test(reason: &str) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DbSlot::Failed(reason.to_string()))),
        }
    }


    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        // Recover from poisoning rather than propagating it.
        //
        // `f(conn)` runs while this guard is held, so *any* panic in *any*
        // closure poisoned the mutex — and propagating that made every
        // subsequent career operation, UI and MCP alike, fail with "lock
        // poisoned" for the rest of the process. A `Connection` is not left in
        // an invalid state by an unwind (rusqlite holds no cross-call borrow),
        // so the honest recovery is to keep using it: one bad ingest should cost
        // that ingest, not the whole career subsystem until the app restarts.
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
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
    // WAL + a busy timeout, because `career.db` genuinely has multiple writers:
    // `lib.rs` manages one `CareerDbState` for the UI and a second for the MCP
    // server, and `--mcp-stdio` opens a third from a *separate process*. Each has
    // its own `Mutex`, so the mutex serializes nothing across them.
    //
    // Under the default rollback journal a writer blocks every reader, and with
    // no busy handler SQLite returns SQLITE_BUSY immediately rather than waiting —
    // which surfaces as spurious "database is locked" errors and, mid-ingest, as
    // the partial-write data loss the transaction above now prevents.
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\
         PRAGMA journal_mode = WAL;\
         PRAGMA busy_timeout = 5000;\
         PRAGMA synchronous = NORMAL;",
    )
    .map_err(|e| format!("Failed to configure career db: {e}"))?;
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

// --- External change watcher ---

/// How often the watcher samples `PRAGMA data_version`. Each sample is an O(1)
/// read on a dedicated connection; 3s keeps cross-process staleness well under
/// a human-perceptible threshold without measurable load.
pub const CHANGE_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Tracks `PRAGMA data_version` for one connection. SQLite guarantees this
/// value changes iff *some other* connection committed since the previous
/// observation — so the app's own writes are invisible here and only genuine
/// external commits (in-app MCP server, `--mcp-stdio` process) are flagged.
struct ExternalChangeDetector {
    last_version: Option<i64>,
}

impl ExternalChangeDetector {
    fn new() -> Self {
        Self { last_version: None }
    }

    /// Returns `Ok(true)` when another connection committed since the previous
    /// call. The first call establishes the baseline and always returns false.
    fn poll(&mut self, conn: &Connection) -> Result<bool, String> {
        let version: i64 = conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .map_err(|e| format!("data_version query failed: {e}"))?;
        let changed = self.last_version.is_some_and(|prev| prev != version);
        self.last_version = Some(version);
        Ok(changed)
    }
}

/// Long-running loop (own thread, own connection) that emits
/// [`CAREER_DB_CHANGED_EVENT`] whenever another connection commits to
/// `career.db`, so the webview can refetch Career surfaces it has cached.
///
/// Best-effort by design: poll failures log once per transition and trigger a
/// reconnect attempt on the next tick; they never take the app down.
pub fn watch_external_changes(app: tauri::AppHandle) {
    let mut detector = ExternalChangeDetector::new();
    let mut conn = match open_connection() {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("[career_db] change watcher: initial open failed: {e}");
            return;
        }
    };

    loop {
        std::thread::sleep(CHANGE_POLL_INTERVAL);
        match detector.poll(&conn) {
            Ok(true) => {
                if let Err(e) = app.emit(CAREER_DB_CHANGED_EVENT, ()) {
                    eprintln!("[career_db] failed to emit {CAREER_DB_CHANGED_EVENT}: {e}");
                }
            }
            Ok(false) => {}
            Err(e) => {
                eprintln!("[career_db] change watcher poll failed ({e}); reconnecting");
                detector = ExternalChangeDetector::new();
                match open_connection() {
                    Ok(next) => conn = next,
                    Err(reopen_err) => {
                        eprintln!("[career_db] change watcher reopen failed: {reopen_err}");
                    }
                }
            }
        }
    }
}

fn parse_updated_at_ms(updated_at: &str) -> i64 {
    // Accept ISO-ish strings; fall back to now.
    if let Ok(n) = updated_at.parse::<i64>() {
        return n;
    }
    now_ms()
}

// --- Blocking helpers ---

pub(crate) fn list_blocks_blocking(
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

/// Blocking vector search, for callers that already hold a connection.
///
/// The MCP tool layer needs this: `career_vector_search` is a Tauri command and
/// is unreachable from the headless MCP transports.
pub(crate) fn vector_search_blocking(
    conn: &Connection,
    query_vec: &[f32],
    k: usize,
    filter: &SearchFilter,
) -> Result<Vec<ScoredHit>, String> {
    vectors::vector_search(conn, query_vec, k, filter)
}

/// Child bullet/fact ids present in the stored block JSON but absent from the
/// incoming payload. An overwrite is a whole-document replace, so those
/// children vanish from the document — their embeddings must go with them or
/// they surface as permanent hits with empty text.
fn removed_child_owner_ids(prior_json: &str, next: &ExperienceBlock) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(prior_json) else {
        return Vec::new();
    };
    let kept: std::collections::HashSet<&str> = next
        .bullets
        .iter()
        .map(|b| b.id.as_str())
        .chain(next.facts.iter().map(|f| f.id.as_str()))
        .collect();
    let mut removed = Vec::new();
    for key in ["bullets", "facts"] {
        if let Some(children) = value.get(key).and_then(|v| v.as_array()) {
            for child in children {
                if let Some(id) = child.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() && !kept.contains(id) {
                        removed.push(id.to_string());
                    }
                }
            }
        }
    }
    removed
}

pub(crate) fn upsert_block_blocking(conn: &Connection, block: &ExperienceBlock) -> Result<(), String> {
    let json =
        serde_json::to_string(block).map_err(|e| format!("Failed to serialize block: {e}"))?;
    let updated_at = parse_updated_at_ms(&block.updated_at);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin block upsert: {e}"))?;

    // Drop embeddings of bullets/facts the payload removed, inside the same
    // transaction as the write: the prior document is read and reconciled
    // atomically with the replace.
    let prior_json: Option<String> = tx
        .query_row(
            "SELECT json FROM blocks WHERE id = ?1",
            params![block.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to load block {}: {e}", block.id))?;
    if let Some(prior) = prior_json.as_deref() {
        for owner_id in removed_child_owner_ids(prior, block) {
            vectors::delete_owner_embeddings(&tx, &owner_id)?;
        }
    }

    tx.execute(
        "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, json = excluded.json, updated_at = excluded.updated_at",
        params![block.id, block.kind, json, updated_at],
    )
    .map_err(|e| format!("Failed to upsert block: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit block upsert: {e}"))?;
    Ok(())
}

/// Append facts to one block inside a single read-modify-write transaction on
/// just that block's row. The previous MCP flow loaded *every* block, extended
/// its match in memory, and rewrote it across two separate lock windows, so a
/// concurrent write to the same block between them was silently lost.
pub(crate) fn append_facts_to_block_blocking(
    conn: &Connection,
    block_id: &str,
    facts: Vec<BlockFact>,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin fact append: {e}"))?;
    let json: Option<String> = tx
        .query_row(
            "SELECT json FROM blocks WHERE id = ?1",
            params![block_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to load block {block_id}: {e}"))?;
    let Some(json) = json else {
        return Err(format!("Block '{block_id}' not found"));
    };
    let mut block: ExperienceBlock =
        serde_json::from_str(&json).map_err(|e| format!("Invalid block JSON in db: {e}"))?;
    block.facts.extend(facts);
    block.updated_at = chrono::Utc::now().to_rfc3339();
    let updated = serde_json::to_string(&block)
        .map_err(|e| format!("Failed to serialize block: {e}"))?;
    tx.execute(
        "INSERT INTO blocks (id, kind, json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, json = excluded.json, updated_at = excluded.updated_at",
        params![block.id, block.kind, updated, parse_updated_at_ms(&block.updated_at)],
    )
    .map_err(|e| format!("Failed to upsert block: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit fact append: {e}"))
}

pub(crate) fn delete_block_blocking(conn: &Connection, id: &str) -> Result<(), String> {
    // Existence check BEFORE any mutation. The previous order deleted the
    // owner embeddings first and only reported 'Block not found' after a
    // zero-row DELETE — mutating the DB on a miss.
    let block_json: Option<String> = conn
        .query_row(
            "SELECT json FROM blocks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to load block {id} before delete: {e}"))?;
    let Some(block_json) = block_json else {
        return Err(format!("Block not found: {id}"));
    };

    // Collect child bullet + fact ids from block JSON before deleting the row.
    let mut owner_ids = vec![id.to_string()];
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&block_json) {
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

    // Embedding deletes and the row delete land or fail together; another
    // process deleting the block mid-flight still yields the not-found error.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin block delete: {e}"))?;
    for owner_id in &owner_ids {
        vectors::delete_owner_embeddings(&tx, owner_id)?;
    }
    let n = tx
        .execute("DELETE FROM blocks WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete block: {e}"))?;
    if n == 0 {
        return Err(format!("Block not found: {id}"));
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit block delete: {e}"))?;
    Ok(())
}

pub(crate) fn list_personas_blocking(conn: &Connection) -> Result<Vec<Persona>, String> {
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

pub(crate) fn upsert_persona_blocking(conn: &Connection, persona: &Persona) -> Result<(), String> {
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

/// Is this one of the built-in personas seeded on first open?
///
/// `pub(crate)` so the MCP tool layer can refuse to let a *remote* caller
/// redefine a built-in. The Tauri command path deliberately stays unrestricted:
/// that is the user editing their own personas in the app.
pub(crate) fn is_seeded_persona_id(id: &str) -> bool {
    SEEDED_PERSONA_IDS.contains(&id)
}

pub(crate) fn delete_persona_blocking(conn: &Connection, id: &str) -> Result<(), String> {
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

pub(crate) fn store_embeddings_blocking(conn: &Connection, items: &[EmbeddingItem]) -> Result<(), String> {
    for item in items {
        // Reject non-finite components at the boundary rather than letting them
        // poison every later similarity score. `Vec<f32>` arrives straight from
        // the frontend, and serde_json parses an out-of-range literal like `1e40`
        // to `f64`, which becomes `inf` on the `as f32` cast.
        if let Some(bad) = item.vec.iter().position(|v| !v.is_finite()) {
            return Err(format!(
                "Embedding for {} contains a non-finite value at index {bad}",
                item.owner_id
            ));
        }
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
        // Record the model for reuse checks, so a later switch of embed models
        // re-embeds instead of counting old-model rows as current.
        vectors::set_active_embed_model(conn, model)?;
    }
    Ok(())
}

pub(crate) fn save_run_blocking(conn: &Connection, run: &SynthesisRun) -> Result<(), String> {
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

pub(crate) fn list_runs_blocking(conn: &Connection) -> Result<Vec<SynthesisRun>, String> {
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

// --- Known projects (cross-process registry for the plugins layer) ---

/// A workspace project registered by the desktop app when it is opened.
///
/// The MCP plugin surface refuses to touch any path that is not in this table:
/// a headless agent has no other way to prove a path is one of *the user's*
/// projects rather than an arbitrary directory on disk. The desktop app is the
/// only writer (on project open); MCP reads it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownProject {
    /// Absolute filesystem path of the project folder.
    pub path: String,
    /// Display name (folder basename unless the user renamed it).
    pub name: String,
    /// Epoch millis of the last open.
    pub last_opened_at: i64,
}

pub(crate) fn upsert_known_project_blocking(
    conn: &Connection,
    path: &str,
    name: &str,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Project path cannot be empty.".to_string());
    }
    conn.execute(
        "INSERT INTO known_projects (path, name, last_opened_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET
           name = CASE WHEN ?2 <> '' THEN ?2 ELSE known_projects.name END,
           last_opened_at = excluded.last_opened_at",
        params![trimmed, name.trim(), now_ms()],
    )
    .map_err(|e| format!("Failed to register project: {e}"))?;
    Ok(())
}

pub(crate) fn remove_known_project_blocking(
    conn: &Connection,
    path: &str,
) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM known_projects WHERE path = ?1", params![path.trim()])
        .map_err(|e| format!("Failed to forget project: {e}"))?;
    Ok(n > 0)
}

pub(crate) fn list_known_projects_blocking(conn: &Connection) -> Result<Vec<KnownProject>, String> {
    let mut stmt = conn
        .prepare("SELECT path, name, last_opened_at FROM known_projects ORDER BY last_opened_at DESC")
        .map_err(|e| format!("Failed to prepare list known projects: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("Failed to query known projects: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let (path, name, last_opened_at) =
            row.map_err(|e| format!("Failed to read known project row: {e}"))?;
        out.push(KnownProject {
            path,
            name,
            last_opened_at,
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
pub async fn career_upsert_known_project(
    state: tauri::State<'_, CareerDbState>,
    path: String,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| upsert_known_project_blocking(c, &path, &name))
    })
    .await
    .map_err(|e| format!("career_upsert_known_project task failed: {e}"))?
}

#[tauri::command]
pub async fn career_remove_known_project(
    state: tauri::State<'_, CareerDbState>,
    path: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        state.with_conn(|c| remove_known_project_blocking(c, &path))
    })
    .await
    .map_err(|e| format!("career_remove_known_project task failed: {e}"))?
}

#[tauri::command]
pub async fn career_list_known_projects(
    state: tauri::State<'_, CareerDbState>,
) -> Result<Vec<KnownProject>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.with_conn(list_known_projects_blocking))
        .await
        .map_err(|e| format!("career_list_known_projects task failed: {e}"))?
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

    /// Two `CareerDbState`s over one DB file — mirrors production where lib.rs
    /// holds a UI state and an MCP server state, plus a third stdio process.
    /// Concurrent KB ingest + reads must all succeed (WAL + busy_timeout absorb
    /// contention) and land every row visible to the *other* connection.
    #[test]
    fn concurrent_ingest_and_list_on_shared_db_file() {
        let _ = vectors::ensure_sqlite_vec_registered();
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("career-stress.db");

        let make_conn = || {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;\
                 PRAGMA journal_mode = WAL;\
                 PRAGMA busy_timeout = 5000;",
            )
            .unwrap();
            schema::init_schema(&conn).unwrap();
            conn
        };

        let ui = CareerDbState {
            inner: Arc::new(Mutex::new(DbSlot::Ready(make_conn()))),
        };
        let mcp = CareerDbState {
            inner: Arc::new(Mutex::new(DbSlot::Ready(make_conn()))),
        };

        const WRITERS: usize = 4;
        const CHUNKS_PER_SOURCE: usize = 6;
        const READER_ITERS: usize = 50;

        let mut handles = Vec::new();
        for w in 0..WRITERS {
            let mcp = mcp.clone();
            handles.push(std::thread::spawn(move || {
                let prepared = PreparedSource {
                    uri: format!("/tmp/career-stress-{w}.md"),
                    source_type: "markdown".to_string(),
                    title: format!("stress-{w}"),
                    content_hash: format!("stress-hash-{w}"),
                    chunks: (0..CHUNKS_PER_SOURCE)
                        .map(|c| ingest::PreparedChunk {
                            text: format!("writer {w} chunk {c} body text"),
                            meta: serde_json::json!({
                                "contentHash": format!("stress-{w}-{c}"),
                            }),
                        })
                        .collect(),
                };
                mcp.with_conn(|conn| {
                    ingest::upsert_prepared_source(conn, &prepared)?;
                    Ok(())
                })
            }));
        }
        for _reader in 0..2 {
            let ui = ui.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..READER_ITERS {
                    let _sources =
                        ui.with_conn(ingest::list_kb_sources)?;
                    let _chunks = ui.with_conn(|conn| {
                        ingest::list_kb_chunks(conn, None, false)
                    })?;
                }
                Ok(())
            }));
        }

        for handle in handles {
            let result = handle
                .join()
                .unwrap_or_else(|panic| Err(format!("thread panicked: {panic:?}")));
            match result {
                Ok(()) => {}
                Err(e) => panic!("concurrent op failed: {e}"),
            }
        }

        let sources = ui
            .with_conn(ingest::list_kb_sources)
            .unwrap_or_else(|e| panic!("final list_kb_sources failed: {e}"));
        assert_eq!(sources.len(), WRITERS);
        for w in 0..WRITERS {
            let title = format!("stress-{w}");
            assert!(
                sources.iter().any(|s| s.title == Some(title.clone())),
                "missing source {title}"
            );
        }
        let total_chunks = ui
            .with_conn(|conn| ingest::list_kb_chunks(conn, None, false))
            .unwrap_or_else(|e| panic!("final list_kb_chunks failed: {e}"));
        assert_eq!(total_chunks.len(), WRITERS * CHUNKS_PER_SOURCE);
    }

    /// The watcher must flag commits from *other* connections (in-app MCP
    /// server, stdio process) and stay silent for the watched connection's own
    /// writes — otherwise every app-initiated save would spam refresh events.
    #[test]
    fn external_change_detector_flags_other_connections_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("career-watch.db");

        let open = || {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;\
                 PRAGMA journal_mode = WAL;",
            )
            .unwrap();
            schema::init_schema(&conn).unwrap();
            conn
        };

        let watched = open();
        let other = open();

        let mut detector = ExternalChangeDetector::new();
        assert!(
            !detector.poll(&watched).unwrap(),
            "baseline poll establishes version and reports no change"
        );
        assert!(
            !detector.poll(&watched).unwrap(),
            "no commits since baseline"
        );

        other
            .execute(
                "INSERT OR REPLACE INTO personas (id, json) VALUES ('ext', '{}')",
                [],
            )
            .unwrap();
        assert!(
            detector.poll(&watched).unwrap(),
            "commit from another connection must be detected"
        );
        assert!(
            !detector.poll(&watched).unwrap(),
            "no further commits since detection"
        );

        watched
            .execute(
                "INSERT OR REPLACE INTO personas (id, json) VALUES ('own', '{}')",
                [],
            )
            .unwrap();
        assert!(
            !detector.poll(&watched).unwrap(),
            "the watched connection's own commit must be invisible"
        );
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
            location: None,
            url: None,
            url_label: None,
            extra: None,
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
            default_template_id: "typst-ats-single-column".into(),
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
            location: None,
            url: None,
            url_label: None,
            extra: None,
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

    fn mk_test_block(id: &str, bullet_ids: &[&str], fact_ids: &[&str]) -> ExperienceBlock {
        ExperienceBlock {
            id: id.into(),
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
            location: None,
            url: None,
            url_label: None,
            extra: None,
            bullets: bullet_ids
                .iter()
                .map(|bid| Bullet {
                    id: (*bid).into(),
                    canonical: format!("Bullet {bid}"),
                    variants: serde_json::Map::new(),
                    metrics: vec![],
                    evidence_refs: vec![],
                    locked: false,
                })
                .collect(),
            facts: fact_ids
                .iter()
                .map(|fid| BlockFact {
                    id: (*fid).into(),
                    text: format!("Fact {fid}"),
                    skills: vec![],
                    metrics: vec![],
                    source: "manual".into(),
                    created_at: "1700000000000".into(),
                })
                .collect(),
            notes: None,
            embedding_text: Some("Eng Acme".into()),
            updated_at: "1700000000000".into(),
        }
    }

    /// An overwrite is a whole-document replace: children dropped from the
    /// payload must lose their embeddings too, or they surface forever as
    /// hits whose text can no longer be resolved.
    #[test]
    fn overwriting_a_block_deletes_embeddings_of_dropped_children() {
        let _ = vectors::ensure_sqlite_vec_registered();
        let state = test_state();
        state
            .with_conn(|c| upsert_block_blocking(c, &mk_test_block("exp_g", &["b1", "b2"], &["f1"])))
            .unwrap();
        let items = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(owner, kind)| EmbeddingItem {
                    owner_id: (*owner).into(),
                    owner_kind: (*kind).into(),
                    model: "test".into(),
                    vec: vec![1.0, 0.0],
                })
                .collect::<Vec<_>>()
        };
        state
            .with_conn(|c| {
                store_embeddings_blocking(
                    c,
                    &items(&[
                        ("exp_g", "block"),
                        ("b1", "bullet"),
                        ("b2", "bullet"),
                        ("f1", "fact"),
                    ]),
                )
            })
            .unwrap();

        // Overwrite keeping only b1; b2 and f1 vanish from the document.
        state
            .with_conn(|c| upsert_block_blocking(c, &mk_test_block("exp_g", &["b1"], &[])))
            .unwrap();

        let remaining = |ids: &[&str]| -> i64 {
            let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
            state
                .with_conn(|c| {
                    c.query_row(
                        "SELECT COUNT(*) FROM embeddings WHERE owner_id IN (SELECT value FROM json_each(?1))",
                        params![serde_json::to_string(&ids).unwrap()],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())
                })
                .unwrap()
        };
        assert_eq!(remaining(&["b2"]), 0, "dropped bullet kept its embedding");
        assert_eq!(remaining(&["f1"]), 0, "dropped fact kept its embedding");
        assert_eq!(remaining(&["b1"]), 1, "kept bullet must retain its embedding");
        assert_eq!(remaining(&["exp_g"]), 1, "block embedding must survive");
    }

    /// The previous order mutated first and validated second: deleting a
    /// non-existent block removed whatever embeddings carried that owner id,
    /// then returned 'Block not found'.
    #[test]
    fn deleting_a_missing_block_leaves_dangling_embeddings_alone() {
        let _ = vectors::ensure_sqlite_vec_registered();
        let state = test_state();
        state
            .with_conn(|c| {
                store_embeddings_blocking(
                    c,
                    &[EmbeddingItem {
                        owner_id: "ghost_block".into(),
                        owner_kind: "block".into(),
                        model: "test".into(),
                        vec: vec![1.0, 0.0],
                    }],
                )
            })
            .unwrap();

        let err = state
            .with_conn(|c| delete_block_blocking(c, "ghost_block"))
            .unwrap_err();
        assert!(err.contains("Block not found"), "got: {err}");

        let n: i64 = state
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM embeddings WHERE owner_id = 'ghost_block'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(n, 1, "failed delete destroyed unrelated embeddings");
    }

    /// Appending facts must read only the target block. A sibling block with
    /// JSON that fails to deserialize used to abort the whole load-everything
    /// pass, making every fact append fail because of an unrelated row.
    #[test]
    fn appending_facts_reads_only_the_target_block() {
        let state = test_state();
        state
            .with_conn(|c| upsert_block_blocking(c, &mk_test_block("exp_ok", &[], &["keep_me"])))
            .unwrap();
        state
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO blocks (id, kind, json, updated_at) VALUES ('exp_bad', 'experience', '{\"id\":\"exp_bad\"}', 0)",
                    [],
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        let fact = BlockFact {
            id: "fact-new".into(),
            text: "Freshly appended fact".into(),
            skills: vec![],
            metrics: vec![],
            source: "manual".into(),
            created_at: "1700000001000".into(),
        };
        state
            .with_conn(|c| append_facts_to_block_blocking(c, "exp_ok", vec![fact]))
            .unwrap();

        // Read back only exp_ok; list_blocks_blocking would rightly refuse the
        // corrupt sibling we planted.
        let json: String = state
            .with_conn(|c| {
                c.query_row(
                    "SELECT json FROM blocks WHERE id = 'exp_ok'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let ok: ExperienceBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(ok.facts.len(), 2);

        let err = state
            .with_conn(|c| append_facts_to_block_blocking(c, "missing_id", Vec::new()))
            .unwrap_err();
        assert!(
            err.contains("Block 'missing_id' not found"),
            "error text changed: {err}"
        );
    }

    /// Each append is one transaction on one row; concurrent writers through
    /// two connections (mirroring UI state vs MCP server state) must not lose
    /// each other's facts.
    #[test]
    fn concurrent_fact_appends_do_not_lose_updates() {
        let _ = vectors::ensure_sqlite_vec_registered();
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("career-append.db");

        let make_state = || {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;\
                 PRAGMA journal_mode = WAL;\
                 PRAGMA busy_timeout = 5000;",
            )
            .unwrap();
            schema::init_schema(&conn).unwrap();
            CareerDbState {
                inner: Arc::new(Mutex::new(DbSlot::Ready(conn))),
            }
        };

        let ui = make_state();
        ui.with_conn(|c| upsert_block_blocking(c, &mk_test_block("exp_race", &[], &[])))
            .unwrap();
        let mcp = make_state();

        const WRITERS: usize = 4;
        const APPENDS: usize = 10;

        let mut handles = Vec::new();
        for w in 0..WRITERS {
            let mcp = mcp.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..APPENDS {
                    let fact = BlockFact {
                        id: format!("fact-{w}-{i}"),
                        text: format!("Writer {w} fact {i}"),
                        skills: vec![],
                        metrics: vec![],
                        source: "manual".into(),
                        created_at: "1700000002000".into(),
                    };
                    mcp.with_conn(|conn| {
                        append_facts_to_block_blocking(conn, "exp_race", vec![fact])
                    })?;
                }
                Ok::<(), String>(())
            }));
        }
        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let listed = ui
            .with_conn(|c| list_blocks_blocking(c, false))
            .unwrap();
        let block = listed.iter().find(|b| b.id == "exp_race").unwrap();
        let seen: std::collections::HashSet<String> =
            block.facts.iter().map(|f| f.id.clone()).collect();
        assert_eq!(
            seen.len(),
            WRITERS * APPENDS,
            "lost updates: {} of {} facts survived",
            seen.len(),
            WRITERS * APPENDS
        );
    }
}
