//! SQLite schema + default persona seed for the career database.

use rusqlite::{OptionalExtension, Connection};
use serde_json::json;

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    kind TEXT,
    json TEXT NOT NULL,
    updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_sources (
    id TEXT PRIMARY KEY,
    source_type TEXT,
    uri TEXT,
    title TEXT,
    content_hash TEXT,
    ingested_at INTEGER
);
CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT REFERENCES kb_sources(id),
    text TEXT,
    meta_json TEXT
);
CREATE TABLE IF NOT EXISTS embeddings (
    owner_id TEXT NOT NULL,
    owner_kind TEXT,
    model TEXT NOT NULL,
    dim INTEGER,
    vec BLOB,
    PRIMARY KEY (owner_id, model)
);
CREATE TABLE IF NOT EXISTS synthesis_runs (
    id TEXT PRIMARY KEY,
    jd_hash TEXT,
    persona_id TEXT,
    template_id TEXT,
    report_json TEXT,
    created_at INTEGER
);
CREATE TABLE IF NOT EXISTS career_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_owner_kind ON embeddings(owner_kind);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_source_id ON kb_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_blocks_kind ON blocks(kind);
"#;

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("Failed to init career schema: {e}"))?;
    migrate_embeddings_pk(conn)?;
    migrate_persona_templates(conn)?;
    // career_meta may be missing on DBs created before it was added.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS career_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to ensure career_meta: {e}"))?;
    Ok(())
}

/// Migrate `embeddings` from `PRIMARY KEY (owner_id)` to `(owner_id, model)`.
///
/// Idempotent: no-ops when the composite key is already in place.
fn migrate_embeddings_pk(conn: &Connection) -> Result<(), String> {
    let table_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to inspect embeddings schema: {e}"))?;

    let Some(sql) = table_sql else {
        return Ok(());
    };

    let normalized: String = sql
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();

    // New schema: PRIMARY KEY (owner_id, model)
    if normalized.contains("primarykey(owner_id,model)") {
        return Ok(());
    }

    // Old schema used `owner_id TEXT PRIMARY KEY` (single-column).
    conn.execute_batch(
        r#"
        BEGIN IMMEDIATE;
        CREATE TABLE embeddings_new (
            owner_id TEXT NOT NULL,
            owner_kind TEXT,
            model TEXT NOT NULL,
            dim INTEGER,
            vec BLOB,
            PRIMARY KEY (owner_id, model)
        );
        INSERT INTO embeddings_new (owner_id, owner_kind, model, dim, vec)
        SELECT
            owner_id,
            owner_kind,
            CASE
                WHEN model IS NULL OR TRIM(model) = '' THEN 'unknown'
                ELSE model
            END,
            dim,
            vec
        FROM embeddings;
        DROP TABLE embeddings;
        ALTER TABLE embeddings_new RENAME TO embeddings;
        CREATE INDEX IF NOT EXISTS idx_embeddings_owner_kind ON embeddings(owner_kind);
        CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("Failed to migrate embeddings PK to (owner_id, model): {e}"))?;

    // ANN index is stale after PK/layout change — drop so it rebuilds lazily.
    let _ = conn.execute("DROP TABLE IF EXISTS vec_embeddings", []);
    let _ = conn.execute("DELETE FROM career_meta WHERE key = 'vec_dim'", []);

    Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM career_meta WHERE key = ?1",
        rusqlite::params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("Failed to read career_meta.{key}: {e}"))
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO career_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("Failed to write career_meta.{key}: {e}"))?;
    Ok(())
}

/// Seed built-in personas if missing. Never overwrites user edits.
/// Legacy LaTeX resume template ids → their Typst replacements.
///
/// The LaTeX resume templates were removed when Typst became the resume
/// engine. Personas stored before that still name them, and an unresolvable
/// `defaultTemplateId` would make Synthesize fail with "Unknown resume
/// template", so rewrite them in place on open.
const LEGACY_TEMPLATE_IDS: &[(&str, &str)] = &[
    ("ats-single-column", "typst-ats-single-column"),
    ("ats-two-column", "typst-ats-two-column"),
];

fn migrate_persona_templates(conn: &Connection) -> Result<(), String> {
    for (old, new) in LEGACY_TEMPLATE_IDS {
        conn.execute(
            "UPDATE personas
                SET json = json_set(json, '$.defaultTemplateId', ?2)
              WHERE json_extract(json, '$.defaultTemplateId') = ?1",
            rusqlite::params![old, new],
        )
        .map_err(|e| format!("Failed to migrate persona template ids: {e}"))?;
    }
    Ok(())
}

pub fn seed_default_personas(conn: &Connection) -> Result<(), String> {
    let defaults = [
        json!({
            "id": "ai",
            "label": "AI / ML",
            "skillWeights": {
                "machine-learning": 1.5,
                "python": 1.2,
                "mlops": 1.3,
                "deep-learning": 1.4,
                "llm": 1.5
            },
            "defaultTemplateId": "typst-ats-single-column",
            "sectionOrder": ["experience", "projects", "skills", "education", "publications"],
            "toneDirective": "Emphasize technical depth, systems impact, and measurable ML outcomes. Prefer precise tooling and method names."
        }),
        json!({
            "id": "life-sciences",
            "label": "Life Sciences",
            "skillWeights": {
                "genomics": 1.5,
                "bioinformatics": 1.4,
                "clinical-nlp": 1.3,
                "nextflow": 1.2,
                "biology": 1.2
            },
            "defaultTemplateId": "typst-ats-single-column",
            "sectionOrder": ["experience", "publications", "projects", "skills", "education"],
            "toneDirective": "Emphasize scientific rigor, domain collaboration, and translational impact. Prefer assay, cohort, and pipeline specifics."
        }),
        json!({
            "id": "management",
            "label": "Management",
            "skillWeights": {
                "leadership": 1.5,
                "strategy": 1.3,
                "hiring": 1.2,
                "roadmap": 1.3,
                "cross-functional": 1.2
            },
            "defaultTemplateId": "typst-ats-single-column",
            "sectionOrder": ["experience", "leadership", "skills", "projects", "education", "publications"],
            "toneDirective": "Emphasize scope, team outcomes, stakeholder alignment, and delivery under ambiguity. Prefer org-level metrics over individual tooling."
        }),
    ];

    let mut stmt = conn
        .prepare("INSERT OR IGNORE INTO personas (id, json) VALUES (?1, ?2)")
        .map_err(|e| format!("Failed to prepare persona seed: {e}"))?;

    for persona in defaults {
        let id = persona
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Default persona missing id".to_string())?;
        let json = serde_json::to_string(&persona)
            .map_err(|e| format!("Failed to serialize default persona: {e}"))?;
        stmt.execute(rusqlite::params![id, json])
            .map_err(|e| format!("Failed to seed persona {id}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_personas_use_the_typst_engine() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        seed_default_personas(&conn).unwrap();

        let stale: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM personas
                  WHERE json_extract(json, '$.defaultTemplateId') NOT LIKE 'typst-%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "a seeded persona still points at a LaTeX template");
    }

    #[test]
    fn migrates_legacy_persona_template_ids() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        // Simulate rows written before Typst replaced LaTeX.
        for (id, template) in [
            ("legacy-one", "ats-single-column"),
            ("legacy-two", "ats-two-column"),
            ("custom", "some-custom-template"),
        ] {
            conn.execute(
                "INSERT INTO personas (id, json) VALUES (?1, ?2)",
                rusqlite::params![
                    id,
                    format!(
                        r#"{{"id":"{id}","label":"L","skillWeights":{{}},"defaultTemplateId":"{template}","sectionOrder":[],"toneDirective":""}}"#
                    )
                ],
            )
            .unwrap();
        }

        migrate_persona_templates(&conn).unwrap();

        let read = |id: &str| -> String {
            conn.query_row(
                "SELECT json_extract(json, '$.defaultTemplateId') FROM personas WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(read("legacy-one"), "typst-ats-single-column");
        assert_eq!(read("legacy-two"), "typst-ats-two-column");
        // A user's own template id must be left alone.
        assert_eq!(read("custom"), "some-custom-template");
    }

    #[test]
    fn persona_migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO personas (id, json) VALUES ('p', ?1)",
            rusqlite::params![
                r#"{"id":"p","label":"L","skillWeights":{},"defaultTemplateId":"ats-single-column","sectionOrder":[],"toneDirective":""}"#
            ],
        )
        .unwrap();
        for _ in 0..3 {
            migrate_persona_templates(&conn).unwrap();
        }
        let v: String = conn
            .query_row(
                "SELECT json_extract(json, '$.defaultTemplateId') FROM personas WHERE id = 'p'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "typst-ats-single-column");
    }

    #[test]
    fn init_schema_creates_tables() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        seed_default_personas(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM personas", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);

        // Re-seed must not duplicate or overwrite.
        seed_default_personas(&conn).unwrap();
        let count2: i64 = conn
            .query_row("SELECT COUNT(*) FROM personas", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count2, 3);
    }

    #[test]
    fn migrate_embeddings_pk_from_legacy() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE embeddings (
                owner_id TEXT PRIMARY KEY,
                owner_kind TEXT,
                model TEXT,
                dim INTEGER,
                vec BLOB
            );
            INSERT INTO embeddings (owner_id, owner_kind, model, dim, vec)
            VALUES ('a', 'block', 'm1', 2, X'000000000000803F');
            "#,
        )
        .unwrap();

        migrate_embeddings_pk(&conn).unwrap();

        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let normalized: String = sql
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase();
        assert!(normalized.contains("primarykey(owner_id,model)"));

        // Second migrate is a no-op.
        migrate_embeddings_pk(&conn).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
