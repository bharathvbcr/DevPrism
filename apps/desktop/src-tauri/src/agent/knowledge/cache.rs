use crate::agent::knowledge::{get_knowledge_dir, LinkedProject};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Result};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

pub fn get_db_path() -> PathBuf {
    let mut path = get_knowledge_dir();
    path.push("knowledge.db");
    path
}

#[allow(dead_code)]
pub struct KnowledgeState {
    pub conn: Arc<Mutex<Connection>>,
}

#[allow(dead_code)]
impl KnowledgeState {
    pub fn new() -> Result<Self> {
        let conn = Connection::open(get_db_path())?;

        // Initialize table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY,
                project_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                summary TEXT NOT NULL,
                key_technologies TEXT NOT NULL
            )",
            [],
        )?;
        init_feature_tables(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn add_observation(
        &self,
        project_id: Uuid,
        file_path: String,
        summary: String,
        key_technologies: Vec<String>,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let tech_json =
            serde_json::to_string(&key_technologies).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO observations (project_id, file_path, summary, key_technologies) VALUES (?1, ?2, ?3, ?4)",
            params![project_id.to_string(), file_path, summary, tech_json],
        )?;
        Ok(())
    }

    pub async fn list_observations(&self, project_id: Uuid) -> Result<Vec<Observation>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT project_id, file_path, summary, key_technologies FROM observations WHERE project_id = ?1")?;
        let obs_iter = stmt.query_map(params![project_id.to_string()], |row| {
            let tech_json: String = row.get(3)?;
            let key_technologies: Vec<String> =
                serde_json::from_str(&tech_json).unwrap_or_default();
            Ok(Observation {
                project_id: Uuid::parse_str(&row.get::<_, String>(0)?)
                    .unwrap_or_else(|_| Uuid::nil()),
                file_path: row.get(1)?,
                summary: row.get(2)?,
                key_technologies,
            })
        })?;

        let mut observations = Vec::new();
        for obs in obs_iter {
            observations.push(obs?);
        }
        Ok(observations)
    }
}

// Keep legacy functions for now by opening new connections (slow, but compatible)
#[allow(dead_code)]
pub fn init_db() -> Result<()> {
    let conn = Connection::open(get_db_path())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY,
            project_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            summary TEXT NOT NULL,
            key_technologies TEXT NOT NULL
        )",
        [],
    )?;
    init_feature_tables(&conn)?;
    Ok(())
}

pub fn sync_linked_projects(projects: &[LinkedProject]) -> Result<()> {
    let mut conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM linked_projects", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO linked_projects (
                id, name, path, tech_stack, tags, role, start_date, end_date, description, notes, last_analyzed
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                path = excluded.path,
                tech_stack = excluded.tech_stack,
                tags = excluded.tags,
                role = excluded.role,
                start_date = excluded.start_date,
                end_date = excluded.end_date,
                description = excluded.description,
                notes = excluded.notes,
                last_analyzed = excluded.last_analyzed",
        )?;
        for project in projects {
            let tech_stack =
                serde_json::to_string(&project.tech_stack).unwrap_or_else(|_| "[]".to_string());
            let tags = serde_json::to_string(&project.tags).unwrap_or_else(|_| "[]".to_string());
            stmt.execute(params![
                project.id.to_string(),
                &project.name,
                project.path.to_string_lossy().to_string(),
                tech_stack,
                tags,
                &project.role,
                &project.start_date,
                &project.end_date,
                &project.description,
                &project.notes,
                project.last_analyzed.map(|dt| dt.to_rfc3339()),
            ])?;
        }
    }
    tx.commit()
}

pub fn list_linked_projects_from_db() -> Result<Vec<LinkedProject>> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, path, tech_stack, tags, role, start_date, end_date, description, notes, last_analyzed
         FROM linked_projects
         ORDER BY name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| {
        let id = Uuid::parse_str(&row.get::<_, String>(0)?).unwrap_or_else(|_| Uuid::nil());
        let tech_stack_json: String = row.get(3)?;
        let tags_json: String = row.get(4)?;
        let last_analyzed = row
            .get::<_, Option<String>>(10)?
            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
            .map(|dt| dt.with_timezone(&Utc));
        Ok(LinkedProject {
            id,
            name: row.get(1)?,
            path: PathBuf::from(row.get::<_, String>(2)?),
            tech_stack: serde_json::from_str(&tech_stack_json).unwrap_or_default(),
            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            role: row.get(5)?,
            start_date: row.get(6)?,
            end_date: row.get(7)?,
            description: row.get(8)?,
            notes: row.get(9)?,
            last_analyzed,
        })
    })?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row?);
    }
    Ok(projects)
}

pub fn sync_manual_skill(
    scope: &str,
    name: &str,
    description: Option<&str>,
    content: &str,
    project_path: Option<&str>,
) -> Result<()> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let id = format!(
        "{}:{}:{}",
        scope,
        project_path.unwrap_or("global"),
        name.to_ascii_lowercase()
    );
    conn.execute(
        "INSERT INTO manual_skills (id, scope, name, description, content, project_path, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            scope = excluded.scope,
            name = excluded.name,
            description = excluded.description,
            content = excluded.content,
            project_path = excluded.project_path,
            updated_at = excluded.updated_at",
        params![
            id,
            scope,
            name,
            description,
            content,
            project_path,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub fn delete_manual_skill(scope: &str, name: &str, project_path: Option<&str>) -> Result<()> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let id = format!(
        "{}:{}:{}",
        scope,
        project_path.unwrap_or("global"),
        name.to_ascii_lowercase()
    );
    conn.execute("DELETE FROM manual_skills WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ManualSkillRecord {
    pub scope: String,
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    pub project_path: Option<String>,
    pub updated_at: String,
}

pub fn list_manual_skills_from_db(project_path: Option<&str>) -> Result<Vec<ManualSkillRecord>> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT scope, name, description, content, project_path, updated_at
         FROM manual_skills
         WHERE scope = 'global' OR project_path = ?1
         ORDER BY scope, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![project_path], |row| {
        Ok(ManualSkillRecord {
            scope: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            content: row.get(3)?,
            project_path: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;

    let mut skills = Vec::new();
    for row in rows {
        skills.push(row?);
    }
    Ok(skills)
}

pub fn sync_resume_knowledge(
    personal_bio: Option<&str>,
    resume_profile: Option<&str>,
    manual_experience: Option<&str>,
    evidence_entries: Option<&str>,
) -> Result<()> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;

    let existing_profile = conn
        .query_row("SELECT data FROM resume_profile WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let mut profile_obj = existing_profile.as_object().cloned().unwrap_or_default();
    if let Some(value) = personal_bio {
        profile_obj.insert("personalBio".to_string(), serde_json::json!(value));
    }
    if let Some(value) = resume_profile {
        profile_obj.insert("resumeProfile".to_string(), serde_json::json!(value));
    }
    let profile_json = serde_json::to_string_pretty(&serde_json::Value::Object(profile_obj))
        .unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "INSERT INTO resume_profile (id, data) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        params![profile_json],
    )?;

    if let Some(value) = manual_experience {
        conn.execute(
            "INSERT INTO manual_experience (id, data, updated_at) VALUES ('manualExperience', ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            params![value, Utc::now().to_rfc3339()],
        )?;
    }
    if let Some(value) = evidence_entries {
        conn.execute(
            "INSERT INTO manual_experience (id, data, updated_at) VALUES ('evidenceEntries', ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            params![value, Utc::now().to_rfc3339()],
        )?;
    }
    Ok(())
}

pub fn get_resume_knowledge() -> Result<serde_json::Value> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;

    let profile = conn
        .query_row("SELECT data FROM resume_profile WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let manual_experience = conn
        .query_row(
            "SELECT data FROM manual_experience WHERE id = 'manualExperience'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let evidence_entries = conn
        .query_row(
            "SELECT data FROM manual_experience WHERE id = 'evidenceEntries'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();

    Ok(serde_json::json!({
        "personalBio": profile.get("personalBio").cloned().unwrap_or_else(|| serde_json::json!("")),
        "resumeProfile": profile.get("resumeProfile").cloned().unwrap_or_else(|| serde_json::json!("")),
        "manualExperience": manual_experience,
        "evidenceEntries": evidence_entries,
    }))
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ProjectSummaryRecord {
    pub project_id: String,
    pub summary: String,
    pub updated_at: String,
}

pub fn upsert_project_summary(project_id: &str, summary: &str) -> Result<ProjectSummaryRecord> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let updated_at = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO project_summaries (project_id, summary, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(project_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
        params![project_id, summary, updated_at],
    )?;
    Ok(ProjectSummaryRecord {
        project_id: project_id.to_string(),
        summary: summary.to_string(),
        updated_at,
    })
}

pub fn sync_project_summaries(summaries: &[ProjectSummaryRecord]) -> Result<()> {
    let mut conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO project_summaries (project_id, summary, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
        )?;
        for summary in summaries {
            stmt.execute(params![
                &summary.project_id,
                &summary.summary,
                &summary.updated_at,
            ])?;
        }
    }
    tx.commit()
}

pub fn list_project_summaries() -> Result<Vec<ProjectSummaryRecord>> {
    let conn = Connection::open(get_db_path())?;
    init_feature_tables(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT project_id, summary, updated_at FROM project_summaries ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectSummaryRecord {
            project_id: row.get(0)?,
            summary: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;
    let mut summaries = Vec::new();
    for row in rows {
        summaries.push(row?);
    }
    Ok(summaries)
}

pub fn list_observations_for_project(project_id: &str) -> Result<Vec<Observation>> {
    let id = Uuid::parse_str(project_id).unwrap_or_else(|_| Uuid::nil());
    list_observations(id)
}

fn init_feature_tables(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS linked_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            tech_stack TEXT NOT NULL DEFAULT '[]',
            tags TEXT NOT NULL DEFAULT '[]',
            role TEXT,
            start_date TEXT,
            end_date TEXT,
            description TEXT,
            notes TEXT,
            last_analyzed TEXT
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS manual_skills (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            content TEXT NOT NULL,
            project_path TEXT,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS resume_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS manual_experience (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS project_summaries (
            project_id TEXT PRIMARY KEY,
            summary TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn add_observation(
    project_id: Uuid,
    file_path: String,
    summary: String,
    key_technologies: Vec<String>,
) -> Result<()> {
    let conn = Connection::open(get_db_path())?;
    let tech_json = serde_json::to_string(&key_technologies).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO observations (project_id, file_path, summary, key_technologies) VALUES (?1, ?2, ?3, ?4)",
        params![project_id.to_string(), file_path, summary, tech_json],
    )?;
    Ok(())
}

pub fn list_observations(project_id: Uuid) -> Result<Vec<Observation>> {
    let conn = Connection::open(get_db_path())?;
    let mut stmt = conn.prepare("SELECT project_id, file_path, summary, key_technologies FROM observations WHERE project_id = ?1")?;
    let obs_iter = stmt.query_map(params![project_id.to_string()], |row| {
        let tech_json: String = row.get(3)?;
        let key_technologies: Vec<String> = serde_json::from_str(&tech_json).unwrap_or_default();
        Ok(Observation {
            project_id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap_or_else(|_| Uuid::nil()),
            file_path: row.get(1)?,
            summary: row.get(2)?,
            key_technologies,
        })
    })?;

    let mut observations = Vec::new();
    for obs in obs_iter {
        observations.push(obs?);
    }
    Ok(observations)
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Observation {
    pub project_id: Uuid,
    pub file_path: String,
    pub summary: String,
    pub key_technologies: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_and_observations() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE observations (
                id INTEGER PRIMARY KEY,
                project_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                summary TEXT NOT NULL,
                key_technologies TEXT NOT NULL
            )",
            [],
        )
        .unwrap();

        let project_id = Uuid::new_v4();
        let tech = vec!["Rust".to_string(), "SQLite".to_string()];
        let tech_json = serde_json::to_string(&tech).unwrap();

        conn.execute(
            "INSERT INTO observations (project_id, file_path, summary, key_technologies) VALUES (?1, ?2, ?3, ?4)",
            params![project_id.to_string(), "src/lib.rs", "Test summary", tech_json],
        ).unwrap();

        let mut stmt = conn.prepare("SELECT project_id, file_path, summary, key_technologies FROM observations WHERE project_id = ?1").unwrap();
        let mut obs_iter = stmt
            .query_map(params![project_id.to_string()], |row| {
                let tech_json: String = row.get(3)?;
                let key_technologies: Vec<String> =
                    serde_json::from_str(&tech_json).unwrap_or_default();
                Ok(Observation {
                    project_id: Uuid::parse_str(&row.get::<_, String>(0)?)
                        .unwrap_or_else(|_| Uuid::nil()),
                    file_path: row.get(1)?,
                    summary: row.get(2)?,
                    key_technologies,
                })
            })
            .unwrap();

        let obs = obs_iter.next().unwrap().unwrap();
        assert_eq!(obs.project_id, project_id);
        assert_eq!(obs.file_path, "src/lib.rs");
        assert_eq!(obs.summary, "Test summary");
        assert_eq!(obs.key_technologies, tech);
    }
}
