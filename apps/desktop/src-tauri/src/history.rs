use git2::{DiffOptions, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature, Sort};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

// ─── Types ───

#[derive(Serialize, Clone)]
pub struct SnapshotInfo {
    pub id: String,
    pub message: String,
    pub timestamp: i64,
    pub labels: Vec<String>,
    pub changed_files: Vec<String>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub file_path: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

/// Per-project mutation lock.
///
/// Snapshots fire on every compile and restores come from the UI; without a
/// lock two could race on the index / HEAD ref. Reads (`history_list`,
/// `history_diff`) stay lock-free — git object reads are safe concurrently.
#[derive(Clone, Default)]
pub struct HistoryState {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl HistoryState {
    async fn lock_for(&self, project_root: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        if locks.len() > 64 {
            locks.retain(|key, lock| key == project_root || Arc::strong_count(lock) > 1);
        }
        locks
            .entry(project_root.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

// ─── Helpers ───

fn history_path(project_root: &str) -> PathBuf {
    Path::new(project_root)
        .join(".claudeprism")
        .join("history.git")
}

fn open_repo(project_root: &str) -> Result<Repository, String> {
    let git_dir = history_path(project_root);
    Repository::open(&git_dir).map_err(|e| format!("Failed to open history repo: {}", e))
}

fn default_signature() -> Result<Signature<'static>, String> {
    Signature::now("DevPrism", "history@claudeprism.local")
        .map_err(|e| format!("Failed to create signature: {}", e))
}

/// Build a map of tag name → commit OID for quick label lookup
fn tag_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(tags) = repo.tag_names(None) {
        for tag_name in tags.iter().flatten() {
            if let Ok(reference) = repo.revparse_single(tag_name) {
                let oid = reference
                    .peel_to_commit()
                    .map(|c| c.id())
                    .unwrap_or(reference.id());
                map.entry(oid).or_default().push(tag_name.to_string());
            }
        }
    }
    map
}

/// The full history-excludes file content. Dependency / build trees mirror the
/// agent-side walk skip-list (`native_agent::EXCLUDE_DIRS`, re-exported from
/// `native_agent::tools`) so tool walks and snapshot staging agree on what is
/// ignorable: committing a node_modules-sized tree into history.git makes every
/// snapshot and restore crawl.
fn excludes_content() -> String {
    let mut trees = String::new();
    for dir in crate::native_agent::EXCLUDE_DIRS {
        // Already covered by their own sections below/above; skip duplicates.
        if matches!(*dir, ".git" | ".prism" | ".claudeprism") {
            continue;
        }
        trees.push_str(dir);
        trees.push_str("/\n");
    }
    // Heavy trees the agent-side list does not cover but history must also
    // never snapshot.
    trees.push_str("vendor/\n__pycache__/\n");

    format!(
        r#"# LaTeX build artifacts
*.aux
*.log
*.out
*.toc
*.lof
*.lot
*.fls
*.fdb_latexmk
*.synctex.gz
*.bbl
*.blg
*.nav
*.snm
*.vrb
*.bcf
*.run.xml

# Output
*.pdf

# OS files
.DS_Store
Thumbs.db

# Git
.git/

# DevPrism internal
.claudeprism/
.prism/
.devprism-*

# Dependency / build trees (kept in sync with native_agent::EXCLUDE_DIRS)
{trees}"#
    )
}

fn ensure_excludes(project_root: &str, repo: &Repository) {
    let excludes_path = Path::new(project_root)
        .join(".claudeprism")
        .join("history-exclude");
    let content = excludes_content();
    let needs_write = match fs::read_to_string(&excludes_path) {
        Ok(existing) => {
            // Migrate: rewrite when missing a marker we expect (.prism/ from an
            // older version, .devprism-* for the track-changes temp files, or
            // the dependency/build-tree section).
            !existing.contains(".prism/")
                || !existing.contains(".devprism-*")
                || !existing.contains("node_modules/")
        }
        Err(_) => true,
    };
    if needs_write {
        let _ = fs::write(&excludes_path, &content);
    }
    // Configure the repo to use this excludes file
    if let Ok(mut config) = repo.config() {
        let _ = config.set_str("core.excludesFile", &excludes_path.to_string_lossy());
    }
}

// ─── Tauri Commands ───

// Every command below is a blocking git operation. Sync Tauri commands run on
// the main thread, and `history_snapshot` stages the entire project — which
// stalled the UI on every pre-compile snapshot. Each command is therefore an
// async wrapper over a `*_blocking` core executed on the blocking pool.

#[tauri::command]
pub async fn history_init(
    state: tauri::State<'_, HistoryState>,
    project_root: String,
) -> Result<(), String> {
    let lock = state.lock_for(&project_root).await;
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || history_init_blocking(project_root))
        .await
        .map_err(|e| format!("history_init task failed: {e}"))?
}

#[tauri::command]
pub fn history_init_blocking(project_root: String) -> Result<(), String> {
    let git_dir = history_path(&project_root);

    if git_dir.exists() {
        // Already initialized — verify and ensure excludes
        let repo =
            Repository::open(&git_dir).map_err(|e| format!("Corrupt history repo: {}", e))?;
        ensure_excludes(&project_root, &repo);
        return Ok(());
    }

    // Create .claudeprism/ dir
    let claudeprism_dir = Path::new(&project_root).join(".claudeprism");
    fs::create_dir_all(&claudeprism_dir)
        .map_err(|e| format!("Failed to create .claudeprism dir: {}", e))?;

    // Init a bare repo with workdir pointing to project root
    let mut opts = RepositoryInitOptions::new();
    opts.bare(false);
    opts.workdir_path(Path::new(&project_root));
    opts.no_reinit(true);

    let repo = Repository::init_opts(&git_dir, &opts)
        .map_err(|e| format!("Failed to init history repo: {}", e))?;

    // Set up excludes file
    ensure_excludes(&project_root, &repo);

    // Create initial commit with all project files
    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    // Add all files (respecting .gitignore)
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files: {}", e))?;
    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "[init] Project opened",
        &tree,
        &[],
    )
    .map_err(|e| format!("Failed to create initial commit: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn history_snapshot(
    state: tauri::State<'_, HistoryState>,
    project_root: String,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let lock = state.lock_for(&project_root).await;
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        history_snapshot_blocking(project_root, message)
    })
    .await
    .map_err(|e| format!("history_snapshot task failed: {e}"))?
}

pub fn history_snapshot_blocking(
    project_root: String,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let repo = open_repo(&project_root)?;

    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    // Stage all changes
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files: {}", e))?;

    // Remove deleted files from index
    let workdir = repo.workdir().ok_or("No workdir")?;
    let entries: Vec<_> = index.iter().map(|e| e.path.clone()).collect();
    for path_bytes in &entries {
        let path_str = String::from_utf8_lossy(path_bytes);
        let full_path = workdir.join(path_str.as_ref());
        if !full_path.exists() {
            let _ = index.remove_path(Path::new(path_str.as_ref()));
        }
    }

    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;

    // Check if there are actual changes vs HEAD
    if let Ok(head) = repo.head() {
        if let Ok(head_commit) = head.peel_to_commit() {
            if head_commit.tree().map(|t| t.id()).unwrap_or(Oid::zero()) == tree_oid {
                // No changes — skip snapshot
                return Ok(None);
            }
        }
    }

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("Failed to create commit: {}", e))?;

    // Collect changed file paths
    let changed_files = if let Some(parent_commit) = parent.as_ref() {
        let parent_tree = parent_commit.tree().ok();
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map(|d| {
                d.deltas()
                    .filter_map(|delta| {
                        delta
                            .new_file()
                            .path()
                            .or_else(|| delta.old_file().path())
                            .map(|p| p.to_string_lossy().to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    let timestamp = chrono::Utc::now().timestamp();

    // Retention: once the graph reaches the threshold, compact it. The newest
    // commit always survives the rebuild, but its OID changes — remap so the
    // caller's snapshot id stays valid.
    let mut id = oid.to_string();
    if count_commits_capped(&repo, COMPACT_THRESHOLD)? >= COMPACT_THRESHOLD {
        if let Some((_, map)) = compact_repo_if_needed(&repo)? {
            if let Some(remapped) = map.get(&oid) {
                id = remapped.to_string();
            }
        }
    }

    Ok(Some(SnapshotInfo {
        id,
        message,
        timestamp,
        labels: vec![],
        changed_files,
    }))
}

// ─── Retention / Compaction ───

/// Total commit count that triggers automatic compaction after a snapshot.
pub const COMPACT_THRESHOLD: usize = 800;

/// Newest unlabeled snapshots retained by compaction. Labeled snapshots are
/// always retained regardless of age.
pub const COMPACT_KEEP_UNLABELED: usize = 250;

const COMPACT_TMP_REF: &str = "refs/heads/devprism-compact-tmp";

#[derive(Serialize)]
pub struct CompactionReport {
    pub before: usize,
    pub after: usize,
    pub removed: usize,
}

/// Count commits from HEAD, stopping once `cap` is exceeded.
fn count_commits_capped(repo: &Repository, cap: usize) -> Result<usize, String> {
    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;
    revwalk
        .push_head()
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    let mut count = 0usize;
    for oid in revwalk {
        oid.map_err(|e| format!("Revwalk error: {}", e))?;
        count += 1;
        if count > cap {
            break;
        }
    }
    Ok(count)
}

/// Collect the first-parent chain root → tip, refusing merges.
///
/// DevPrism history is append-only linear by construction (restores create new
/// commits instead of moving branches). A merge would mean something outside
/// wrote to this repo — refuse rather than guess.
fn collect_linear_chain(repo: &Repository) -> Result<Vec<Oid>, String> {
    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;
    revwalk
        .push_head()
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    revwalk
        .set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)
        .map_err(|e| format!("Sort error: {}", e))?;

    let mut chain = Vec::new();
    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| format!("Revwalk error: {}", e))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;
        if commit.parent_count() > 1 {
            return Err(
                "Refusing to compact: history contains a merge commit".to_string(),
            );
        }
        chain.push(oid);
    }
    Ok(chain)
}

/// Compact history: drop all but the newest [`COMPACT_KEEP_UNLABELED`]
/// unlabeled commits; labeled snapshots survive forever.
///
/// Design (the retention decision):
/// - This history is DevPrism's private audit log, not shared source control.
///   Auto-snapshots are noise-reduction by design; durable checkpoints are
///   user-created labels. Bounding unlabeled states matches those semantics.
/// - Safety: the replacement chain is built on a temporary ref and swapped in
///   with a single atomic ref update. Tags are remapped *before* the swap with
///   best-effort rollback on error, so every fallible step before the swap can
///   restore the original state; nothing fallible happens after it except
///   deleting the temp ref.
/// - Per-commit trees, messages and timestamps are preserved exactly, so
///   `history_list` ordering and `history_file_at` lookups behave identically.
///
/// Returns `Ok(None)` when there was nothing to do (below threshold, fully
/// labeled, merge detected upstream of the refusal, etc.).
pub fn history_compact_blocking(
    project_root: String,
) -> Result<Option<CompactionReport>, String> {
    let repo = open_repo(&project_root)?;
    Ok(compact_repo_if_needed(&repo)?.map(|(report, _)| report))
}

fn compact_repo_if_needed(
    repo: &Repository,
) -> Result<Option<(CompactionReport, HashMap<Oid, Oid>)>, String> {
    compact_repo_with(repo, COMPACT_THRESHOLD, COMPACT_KEEP_UNLABELED)
}

/// Parameterized core (tests use small thresholds for speed and determinism;
/// production goes through `compact_repo_if_needed` with the real constants).
fn compact_repo_with(
    repo: &Repository,
    threshold: usize,
    keep_unlabeled: usize,
) -> Result<Option<(CompactionReport, HashMap<Oid, Oid>)>, String> {
    // Pre-flight: we need a symbolic HEAD on a branch to swap atomically.
    let branch_ref_name = {
        let head_ref = repo
            .head()
            .map_err(|e| format!("Refusing to compact: cannot resolve HEAD: {}", e))?;
        if !head_ref.is_branch() {
            return Err("Refusing to compact: HEAD is detached".to_string());
        }
        head_ref
            .name()
            .ok_or_else(|| "Refusing to compact: non-UTF8 branch name".to_string())?
            .to_string()
    };

    let chain = collect_linear_chain(&repo)?;
    let before = chain.len();
    // Act when the graph is at or above the threshold; below it there is
    // nothing worth rebuilding.
    if before < threshold {
        return Ok(None);
    }

    let tags = tag_map(&repo);
    let labeled: HashSet<Oid> = tags.keys().copied().collect();

    // Keep every labeled commit plus the newest KEEP_UNLABELED unlabeled ones.
    let unlabeled_positions: Vec<usize> = chain
        .iter()
        .enumerate()
        .filter_map(|(i, oid)| (!labeled.contains(oid)).then_some(i))
        .collect();
    let Some(cutoff_position) =
        unlabeled_positions.len().checked_sub(keep_unlabeled).and_then(|from| {
            unlabeled_positions.get(from).copied()
        })
    else {
        // Fewer unlabeled commits than the budget keeps — nothing to drop.
        return Ok(None);
    };

    let keep: Vec<bool> = chain
        .iter()
        .enumerate()
        .map(|(i, oid)| labeled.contains(oid) || i >= cutoff_position)
        .collect();
    let kept_count = keep.iter().filter(|k| **k).count();
    if kept_count == before {
        return Ok(None);
    }

    // Rebuild the kept chain on the temp ref. Original trees/blobs stay in the
    // object database, so recreation is metadata-only (no blob copying).
    let _ = repo.find_reference(COMPACT_TMP_REF).and_then(|mut r| r.delete());
    let mut old_to_new: HashMap<Oid, Oid> = HashMap::with_capacity(kept_count);
    let mut new_tip: Option<Oid> = None;

    for (i, &old_oid) in chain.iter().enumerate() {
        if !keep[i] {
            continue;
        }
        let commit = repo
            .find_commit(old_oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;
        let tree = commit
            .tree()
            .map_err(|e| format!("Tree error: {}", e))?;
        let time = commit.time();
        let sig = Signature::new("DevPrism", "history@claudeprism.local", &time)
            .map_err(|e| format!("Signature error: {}", e))?;
        let message = commit.message().unwrap_or("").to_string();

        let parent_commits: Vec<git2::Commit> = match new_tip {
            Some(parent_oid) => vec![repo
                .find_commit(parent_oid)
                .map_err(|e| format!("Failed to find rebuilt parent: {}", e))?],
            None => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();

        let new_oid = repo
            .commit(Some(COMPACT_TMP_REF), &sig, &sig, &message, &tree, &parent_refs)
            .map_err(|e| format!("Failed to rebuild commit: {}", e))?;

        old_to_new.insert(old_oid, new_oid);
        new_tip = Some(new_oid);
    }
    let new_tip = new_tip.ok_or("Compaction produced no commits")?;

    // Remap tags onto the rebuilt chain. On any failure, roll back the tags we
    // already moved so the repository is left exactly as it was.
    let tag_names: Vec<String> = tags
        .values()
        .flatten()
        .cloned()
        .collect();

    // Remap each lightweight tag onto the rebuilt chain. Returns the already-
    // moved tags on failure so the caller can roll them back.
    fn remap_tags(
        repo: &Repository,
        tag_names: &[String],
        old_to_new: &HashMap<Oid, Oid>,
    ) -> Result<(), (String, Vec<(String, Oid)>)> {
        let mut applied: Vec<(String, Oid)> = Vec::new();
        for name in tag_names {
            let refname = format!("refs/tags/{}", name);
            let result = (|| -> Result<Oid, String> {
                let mut reference = repo
                    .find_reference(&refname)
                    .map_err(|e| format!("Label ref missing: {}", e))?;
                let target = reference.target().ok_or_else(|| {
                    format!("Refusing to compact: label `{name}` is symbolic")
                })?;
                // Annotated tags point at tag objects, not commits; we never
                // create them, so their presence means something else wrote here.
                if repo.find_tag(target).is_ok() {
                    return Err(format!(
                        "Refusing to compact: label `{name}` is annotated"
                    ));
                }
                let new_oid = old_to_new.get(&target).copied().ok_or_else(|| {
                    format!(
                        "Refusing to compact: label `{name}` points outside the history chain"
                    )
                })?;
                reference
                    .delete()
                    .map_err(|e| format!("Failed to move label `{name}`: {}", e))?;
                repo.reference(&refname, new_oid, true, "devprism: compaction")
                    .map_err(|e| format!("Failed to move label `{name}`: {}", e))?;
                Ok(target)
            })();
            match result {
                Ok(old_target) => applied.push((refname, old_target)),
                Err(err) => return Err((err, applied)),
            }
        }
        Ok(())
    }

    if let Err((err, applied_remaps)) = remap_tags(&repo, &tag_names, &old_to_new) {
        for (refname, old_target) in applied_remaps.iter().rev() {
            let _ = repo.reference(refname, *old_target, true, "devprism: compaction rollback");
        }
        let _ = repo.find_reference(COMPACT_TMP_REF).and_then(|mut r| r.delete());
        return Err(err);
    }

    // Single atomic swap. Past this point the operation is committed.
    repo.reference(&branch_ref_name, new_tip, true, "devprism: compact history")
        .map_err(|e| format!("Failed to swap compacted history: {}", e))?;

    // Temp ref cleanup is cosmetic — ignore failures.
    if let Ok(mut tmp) = repo.find_reference(COMPACT_TMP_REF) {
        let _ = tmp.delete();
    }

    let report = CompactionReport {
        before,
        after: kept_count,
        removed: before - kept_count,
    };
    eprintln!(
        "[history] compacted {} → {} commits ({} removed)",
        report.before, report.after, report.removed
    );
    Ok(Some((report, old_to_new)))
}

/// Manual compaction entry point (also invoked automatically after snapshots
/// cross [`COMPACT_THRESHOLD`]).
#[tauri::command]
pub async fn history_compact(
    state: tauri::State<'_, HistoryState>,
    project_root: String,
) -> Result<Option<CompactionReport>, String> {
    let lock = state.lock_for(&project_root).await;
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open_repo(&project_root)?;
        let result = compact_repo_if_needed(&repo)?;
        Ok(result.map(|(report, _)| report))
    })
    .await
    .map_err(|e| format!("history_compact task failed: {e}"))?
}

#[tauri::command]
pub async fn history_list(
    project_root: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<SnapshotInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_list_blocking(project_root, limit, offset)
    })
    .await
    .map_err(|e| format!("history_list task failed: {e}"))?
}

pub fn history_list_blocking(
    project_root: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<SnapshotInfo>, String> {
    let repo = open_repo(&project_root)?;
    let tags = tag_map(&repo);

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;
    revwalk
        .push_head()
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|e| format!("Sort error: {}", e))?;

    let mut snapshots = Vec::new();
    let mut count = 0u32;

    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| format!("Revwalk error: {}", e))?;

        if count < offset {
            count += 1;
            continue;
        }
        if snapshots.len() >= limit as usize {
            break;
        }

        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let message = commit.message().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let labels = tags.get(&oid).cloned().unwrap_or_default();

        // Collect changed file paths (vs parent)
        let changed_files = if let Some(parent) = commit.parents().next() {
            let old_tree = parent.tree().ok();
            let new_tree = commit.tree().ok();
            repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), None)
                .map(|d| {
                    d.deltas()
                        .filter_map(|delta| {
                            delta
                                .new_file()
                                .path()
                                .or_else(|| delta.old_file().path())
                                .map(|p| p.to_string_lossy().to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        snapshots.push(SnapshotInfo {
            id: oid.to_string(),
            message,
            timestamp,
            labels,
            changed_files,
        });

        count += 1;
    }

    Ok(snapshots)
}

#[tauri::command]
pub async fn history_diff(
    project_root: String,
    from_id: String,
    to_id: String,
) -> Result<Vec<FileDiff>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_diff_blocking(project_root, from_id, to_id)
    })
    .await
    .map_err(|e| format!("history_diff task failed: {e}"))?
}

pub fn history_diff_blocking(
    project_root: String,
    from_id: String,
    to_id: String,
) -> Result<Vec<FileDiff>, String> {
    let repo = open_repo(&project_root)?;

    let from_oid = Oid::from_str(&from_id).map_err(|e| format!("Invalid from_id: {}", e))?;
    let to_oid = Oid::from_str(&to_id).map_err(|e| format!("Invalid to_id: {}", e))?;

    let from_commit = repo
        .find_commit(from_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let to_commit = repo
        .find_commit(to_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    let from_tree = from_commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;
    let to_tree = to_commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    let mut diff_opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut diff_opts))
        .map_err(|e| format!("Diff error: {}", e))?;

    let mut results = Vec::new();

    for delta in diff.deltas() {
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            _ => "modified",
        }
        .to_string();

        let old_content = if delta.status() != git2::Delta::Added {
            let old_blob = repo.find_blob(delta.old_file().id()).ok();
            old_blob.and_then(|b| {
                if b.is_binary() {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        let new_content = if delta.status() != git2::Delta::Deleted {
            let new_blob = repo.find_blob(delta.new_file().id()).ok();
            new_blob.and_then(|b| {
                if b.is_binary() {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        results.push(FileDiff {
            file_path,
            status,
            old_content,
            new_content,
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn history_file_at(
    project_root: String,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_file_at_blocking(project_root, snapshot_id, file_path)
    })
    .await
    .map_err(|e| format!("history_file_at task failed: {e}"))?
}

pub fn history_file_at_blocking(
    project_root: String,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;
    let entry = tree
        .get_path(Path::new(&file_path))
        .map_err(|e| format!("File not found in snapshot: {}", e))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("Blob error: {}", e))?;

    if blob.is_binary() {
        return Err("Binary file".into());
    }

    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

#[tauri::command]
pub async fn history_restore(
    state: tauri::State<'_, HistoryState>,
    project_root: String,
    snapshot_id: String,
) -> Result<SnapshotInfo, String> {
    let lock = state.lock_for(&project_root).await;
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        history_restore_blocking(project_root, snapshot_id)
    })
    .await
    .map_err(|e| format!("history_restore task failed: {e}"))?
}

pub fn history_restore_blocking(project_root: String, snapshot_id: String) -> Result<SnapshotInfo, String> {
    // Safety net before force-checkout: capture any uncommitted work so a
    // restore can never silently destroy it. No-op when the tree matches HEAD.
    history_snapshot_blocking(
        project_root.clone(),
        "[pre-restore] Auto-save of uncommitted changes".to_string(),
    )?;

    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    // Checkout the tree to working directory
    repo.checkout_tree(
        tree.as_object(),
        Some(git2::build::CheckoutBuilder::new().force()),
    )
    .map_err(|e| format!("Checkout failed: {}", e))?;

    // Create a new "restore" commit on HEAD (not moving HEAD to old commit)
    let mut index = repo.index().map_err(|e| format!("Index error: {}", e))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Add error: {}", e))?;
    index.write().map_err(|e| format!("Write error: {}", e))?;

    let new_tree_oid = index
        .write_tree()
        .map_err(|e| format!("Write tree error: {}", e))?;
    let new_tree = repo
        .find_tree(new_tree_oid)
        .map_err(|e| format!("Find tree error: {}", e))?;

    let sig = default_signature()?;
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = head_commit.iter().collect();

    let short_id = &snapshot_id[..8.min(snapshot_id.len())];
    let msg = format!("[restore] Restored to {}", short_id);
    let new_oid = repo
        .commit(Some("HEAD"), &sig, &sig, &msg, &new_tree, &parents)
        .map_err(|e| format!("Commit error: {}", e))?;

    Ok(SnapshotInfo {
        id: new_oid.to_string(),
        message: msg,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files: vec![],
    })
}

#[tauri::command]
pub async fn history_add_label(
    project_root: String,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_add_label_blocking(project_root, snapshot_id, label)
    })
    .await
    .map_err(|e| format!("history_add_label task failed: {e}"))?
}

pub fn history_add_label_blocking(
    project_root: String,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    repo.tag_lightweight(&label, commit.as_object(), false)
        .map_err(|e| format!("Failed to create label: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn history_remove_label(project_root: String, label: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_remove_label_blocking(project_root, label)
    })
    .await
    .map_err(|e| format!("history_remove_label task failed: {e}"))?
}

pub fn history_remove_label_blocking(project_root: String, label: String) -> Result<(), String> {
    let repo = open_repo(&project_root)?;
    let tag_ref = format!("refs/tags/{}", label);
    repo.find_reference(&tag_ref)
        .map_err(|e| format!("Label not found: {}", e))?
        .delete()
        .map_err(|e| format!("Failed to delete label: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Create a temp project dir with the given files.
    fn setup_project(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (name, content) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, content).unwrap();
        }
        dir
    }

    fn root(dir: &TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    // ─── history_init ───

    #[test]
    fn test_history_init_creates_repo() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        history_init_blocking(root(&dir)).unwrap();

        let git_dir = dir.path().join(".claudeprism").join("history.git");
        assert!(git_dir.exists(), "history.git should be created");

        // Should have an initial commit
        let repo = Repository::open(&git_dir).unwrap();
        let head = repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert!(commit.message().unwrap().contains("[init]"));
    }

    #[test]
    fn test_history_init_idempotent() {
        let dir = setup_project(&[("main.tex", "hello")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        // Second call should succeed without error
        history_init_blocking(r).unwrap();
    }

    #[test]
    fn test_history_init_creates_excludes() {
        let dir = setup_project(&[("main.tex", "doc")]);
        history_init_blocking(root(&dir)).unwrap();

        let excludes = dir.path().join(".claudeprism").join("history-exclude");
        assert!(excludes.exists());
        let content = fs::read_to_string(&excludes).unwrap();
        assert!(content.contains("*.aux"));
        assert!(content.contains(".claudeprism/"));
        assert!(content.contains(".prism/"));
    }

    #[test]
    fn test_excludes_list_dependency_and_build_trees() {
        let dir = setup_project(&[("main.tex", "doc")]);
        history_init_blocking(root(&dir)).unwrap();

        let content =
            fs::read_to_string(dir.path().join(".claudeprism").join("history-exclude")).unwrap();
        for pattern in ["node_modules/", "target/", "dist/", "build/", ".venv/", "vendor/"] {
            assert!(content.contains(pattern), "history excludes missing {pattern}");
        }
    }

    /// Dependency/build trees present at init time must never be committed into
    /// history.git: a node_modules-sized tree makes every snapshot and restore
    /// crawl. Walks the committed tree of the snapshot commit.
    #[test]
    fn test_dependency_trees_are_not_tracked_in_snapshots() {
        let dir = setup_project(&[
            ("main.tex", "\\documentclass{article}"),
            ("node_modules/leftpad/index.js", "module.exports = 1;"),
            ("target/debug/junk.bin", "\x00\x01"),
        ]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // A snapshot after init must not pick them up either.
        fs::write(dir.path().join("chapter.tex"), "new").unwrap();
        let snap = history_snapshot_blocking(r.clone(), "add chapter".into())
            .unwrap()
            .expect("snapshot with a real change");

        let repo = Repository::open(dir.path().join(".claudeprism").join("history.git")).unwrap();
        let commit = repo
            .revparse_single(&snap.id)
            .unwrap()
            .peel_to_commit()
            .unwrap();
        let tree = commit.tree().unwrap();
        let mut tracked: Vec<String> = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if let Some(name) = entry.name() {
                let path = if root.is_empty() {
                    name.to_string()
                } else {
                    format!("{root}/{name}")
                };
                if entry.kind() == Some(git2::ObjectType::Blob) {
                    tracked.push(path);
                }
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        assert!(
            !tracked.iter().any(|p| p.starts_with("node_modules/")),
            "node_modules file tracked in history: {tracked:?}"
        );
        assert!(
            !tracked.iter().any(|p| p.starts_with("target/")),
            "target file tracked in history: {tracked:?}"
        );
        assert!(
            tracked.iter().any(|p| p == "main.tex"),
            "project source must still be tracked"
        );
        assert!(
            tracked.iter().any(|p| p == "chapter.tex"),
            "ordinary new sources must still be tracked"
        );
    }

    // ─── history_snapshot ───

    #[test]
    fn test_history_snapshot_after_modification() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // Modify a file
        fs::write(dir.path().join("main.tex"), "v2").unwrap();

        let result = history_snapshot_blocking(r, "edited main.tex".into()).unwrap();
        assert!(result.is_some());
        let snap = result.unwrap();
        assert_eq!(snap.message, "edited main.tex");
        assert!(snap.changed_files.contains(&"main.tex".to_string()));
    }

    #[test]
    fn test_history_snapshot_no_change_returns_none() {
        let dir = setup_project(&[("main.tex", "same")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // No modification → None
        let result = history_snapshot_blocking(r, "no-op".into()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_history_snapshot_detects_new_file() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // Add a new file
        fs::write(dir.path().join("chapter1.tex"), "new chapter").unwrap();

        let snap = history_snapshot_blocking(r, "add chapter".into()).unwrap().unwrap();
        assert!(snap.changed_files.contains(&"chapter1.tex".to_string()));
    }

    // ─── history_list ───

    #[test]
    fn test_history_list_after_snapshots() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "v2").unwrap();
        history_snapshot_blocking(r.clone(), "snap 1".into()).unwrap();

        fs::write(dir.path().join("main.tex"), "v3").unwrap();
        history_snapshot_blocking(r.clone(), "snap 2".into()).unwrap();

        let list = history_list_blocking(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3); // init + 2 snapshots
        let msgs: Vec<&str> = list.iter().map(|s| s.message.as_str()).collect();
        assert!(msgs.contains(&"snap 1"));
        assert!(msgs.contains(&"snap 2"));
        assert!(msgs.iter().any(|m| m.contains("[init]")));
    }

    #[test]
    fn test_history_list_pagination() {
        let dir = setup_project(&[("a.tex", "x")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        fs::write(dir.path().join("a.tex"), "y").unwrap();
        history_snapshot_blocking(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "z").unwrap();
        history_snapshot_blocking(r.clone(), "s2".into()).unwrap();

        // limit=1 → returns exactly 1 entry
        let page1 = history_list_blocking(r.clone(), 1, 0).unwrap();
        assert_eq!(page1.len(), 1);

        // offset=1 → returns a different entry
        let page2 = history_list_blocking(r.clone(), 1, 1).unwrap();
        assert_eq!(page2.len(), 1);
        assert_ne!(page1[0].id, page2[0].id);

        // All 3 entries accessible
        let all = history_list_blocking(r, 10, 0).unwrap();
        assert_eq!(all.len(), 3);
    }

    // ─── history_diff ───

    #[test]
    fn test_history_diff_shows_changes() {
        let dir = setup_project(&[("main.tex", "old content")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "new content").unwrap();
        let snap = history_snapshot_blocking(r.clone(), "update".into())
            .unwrap()
            .unwrap();

        let list = history_list_blocking(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id.clone();

        let diffs = history_diff_blocking(r, from_id, to_id).unwrap();
        assert!(!diffs.is_empty());
        let d = diffs.iter().find(|d| d.file_path == "main.tex").unwrap();
        assert_eq!(d.status, "modified");
        assert_eq!(d.old_content.as_deref(), Some("old content"));
        assert_eq!(d.new_content.as_deref(), Some("new content"));
    }

    #[test]
    fn test_history_diff_added_file() {
        let dir = setup_project(&[("a.tex", "a")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        fs::write(dir.path().join("b.tex"), "new file").unwrap();
        let snap = history_snapshot_blocking(r.clone(), "add b".into())
            .unwrap()
            .unwrap();

        let list = history_list_blocking(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id;

        let diffs = history_diff_blocking(r, from_id, to_id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "added");
        assert!(d.old_content.is_none());
        assert_eq!(d.new_content.as_deref(), Some("new file"));
    }

    // ─── history_file_at ───

    #[test]
    fn test_history_file_at_returns_content() {
        let dir = setup_project(&[("main.tex", "version one")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        let content = history_file_at_blocking(r, init_id, "main.tex".into()).unwrap();
        assert_eq!(content, "version one");
    }

    #[test]
    fn test_history_file_at_nonexistent_file_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        let result = history_file_at_blocking(r, id, "nonexistent.tex".into());
        assert!(result.is_err());
    }

    // ─── history_restore ───

    #[test]
    fn test_history_restore_reverts_content() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        // Modify
        fs::write(dir.path().join("main.tex"), "modified").unwrap();
        history_snapshot_blocking(r.clone(), "modify".into()).unwrap();

        // Restore to init
        let restore_info = history_restore_blocking(r.clone(), init_id).unwrap();
        assert!(restore_info.message.contains("[restore]"));

        // Working directory should have original content
        let content = fs::read_to_string(dir.path().join("main.tex")).unwrap();
        assert_eq!(content, "original");
    }

    // ─── labels ───

    #[test]
    fn test_history_add_and_remove_label() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        // Add label
        history_add_label_blocking(r.clone(), id.clone(), "v1.0".into()).unwrap();

        // Verify label appears in list
        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        assert!(list[0].labels.contains(&"v1.0".to_string()));

        // Remove label
        history_remove_label_blocking(r.clone(), "v1.0".into()).unwrap();

        // Verify label gone
        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        assert!(!list[0].labels.contains(&"v1.0".to_string()));
    }

    #[test]
    fn test_history_remove_nonexistent_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let result = history_remove_label_blocking(r, "nope".into());
        assert!(result.is_err());
    }

    // ─── tag_map ───

    #[test]
    fn test_tag_map_groups_by_oid() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label_blocking(r.clone(), id.clone(), "alpha".into()).unwrap();
        history_add_label_blocking(r.clone(), id.clone(), "beta".into()).unwrap();

        let repo = open_repo(&r).unwrap();
        let map = tag_map(&repo);
        let oid = Oid::from_str(&id).unwrap();
        let labels = map.get(&oid).unwrap();
        assert!(labels.contains(&"alpha".to_string()));
        assert!(labels.contains(&"beta".to_string()));
    }

    // ─── ensure_excludes ───

    #[test]
    fn test_ensure_excludes_migrates_missing_prism() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // Write an excludes file WITHOUT .prism/
        let excludes_path = dir.path().join(".claudeprism").join("history-exclude");
        fs::write(&excludes_path, "*.aux\n*.log\n.claudeprism/\n").unwrap();

        let repo = open_repo(&r).unwrap();
        ensure_excludes(&r, &repo);

        let content = fs::read_to_string(&excludes_path).unwrap();
        assert!(
            content.contains(".prism/"),
            "should migrate to include .prism/"
        );
    }

    // ─── edge cases ───

    #[test]
    fn test_history_snapshot_deleted_file() {
        let dir = setup_project(&[("a.tex", "aaa"), ("b.tex", "bbb")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // Delete a file
        fs::remove_file(dir.path().join("b.tex")).unwrap();

        let snap = history_snapshot_blocking(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();
        assert!(!snap.changed_files.is_empty());
    }

    #[test]
    fn test_history_diff_deleted_file() {
        let dir = setup_project(&[("a.tex", "keep"), ("b.tex", "remove me")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        fs::remove_file(dir.path().join("b.tex")).unwrap();
        let snap = history_snapshot_blocking(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();

        let diffs = history_diff_blocking(r, init_id, snap.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "deleted");
        assert_eq!(d.old_content.as_deref(), Some("remove me"));
        assert!(d.new_content.is_none());
    }

    #[test]
    fn test_history_diff_nonadjacent_snapshots() {
        let dir = setup_project(&[("a.tex", "v1")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list0 = history_list_blocking(r.clone(), 1, 0).unwrap();
        let init_id = list0[0].id.clone();

        fs::write(dir.path().join("a.tex"), "v2").unwrap();
        history_snapshot_blocking(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "v3").unwrap();
        let snap3 = history_snapshot_blocking(r.clone(), "s2".into()).unwrap().unwrap();

        // Diff from init directly to s2 (skipping s1)
        let diffs = history_diff_blocking(r, init_id, snap3.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "a.tex").unwrap();
        assert_eq!(d.old_content.as_deref(), Some("v1"));
        assert_eq!(d.new_content.as_deref(), Some("v3"));
    }

    #[test]
    fn test_history_add_duplicate_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label_blocking(r.clone(), id.clone(), "dup".into()).unwrap();
        // Adding same label again should error
        let result = history_add_label_blocking(r, id, "dup".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_history_restore_creates_restore_commit() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let init_list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let init_id = init_list[0].id.clone();

        fs::write(dir.path().join("main.tex"), "changed").unwrap();
        history_snapshot_blocking(r.clone(), "change".into()).unwrap();

        history_restore_blocking(r.clone(), init_id).unwrap();

        // Should now have 4 entries: init, change, restore
        let list = history_list_blocking(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().any(|s| s.message.contains("[restore]")));
    }

    #[test]
    fn test_history_restore_preserves_uncommitted_work() {
        // Restoring force-checkouts the working tree. Uncommitted edits must
        // be auto-snapshotted first — otherwise a restore silently destroys
        // them.
        let dir = setup_project(&[("main.tex", "committed")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let list = history_list_blocking(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        // Uncommitted edit on top of HEAD.
        fs::write(dir.path().join("main.tex"), "precious uncommitted draft").unwrap();

        let before = history_list_blocking(r.clone(), 100, 0).unwrap().len();

        history_restore_blocking(r.clone(), init_id).unwrap();

        // The pre-restore snapshot captured the uncommitted state...
        let list = history_list_blocking(r.clone(), 100, 0).unwrap();
        assert_eq!(list.len(), before + 2); // [pre-restore] + [restore]
        let pre_restore = list
            .iter()
            .find(|s| s.message.contains("[pre-restore]"))
            .expect("pre-restore snapshot must exist");
        assert!(pre_restore.changed_files.contains(&"main.tex".to_string()));

        // ...and its committed content is recoverable via history_file_at.
        let content =
            history_file_at_blocking(r, pre_restore.id.clone(), "main.tex".into()).unwrap();
        assert_eq!(content, "precious uncommitted draft");
    }

    // ─── compaction / retention ───

    use super::compact_repo_with;

    /// Small thresholds keep the suite fast and deterministic; the real
    /// constants path is exercised by `auto_compaction_remaps_snapshot_id`.
    const T: usize = 30;
    const K: usize = 10;

    /// Build `n` unlabeled snapshots (plus `[init]`) on a fresh project.
    fn build_history(dir: &TempDir, n: usize) -> Vec<String> {
        let r = root(dir);
        for i in 0..n {
            let content = format!("content v{i}");
            fs::write(dir.path().join("main.tex"), &content).unwrap();
            let snap = history_snapshot_blocking(r.clone(), format!("snap {i}"))
                .unwrap()
                .expect("snapshot must be created");
            assert!(
                !snap.id.is_empty(),
                "snapshot id must be usable by callers"
            );
        }
        history_list_blocking(r, u32::MAX, 0)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect()
    }

    #[test]
    fn compaction_noop_below_threshold() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        build_history(&dir, 5);

        // init + 5 snapshots = 6 ≤ T → no-op.
        let report = compact_repo_with(&open_repo(&r).unwrap(), T, K)
            .unwrap()
            .map(|(rep, _)| rep);
        assert!(report.is_none());
    }

    #[test]
    fn compaction_drops_old_unlabeled_and_keeps_newest() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        let created = T + 10; // init + 40 commits with T=30
        let ids = build_history(&dir, created);

        let repo = open_repo(&r).unwrap();
        let (report, _) = compact_repo_with(&repo, T, K).unwrap().unwrap();
        assert_eq!(report.before, created + 1); // + [init]
        assert_eq!(report.after, K);
        assert_eq!(report.removed, report.before - report.after);

        let after = count_commits_capped(&repo, usize::MAX).unwrap();
        assert_eq!(after, K);

        // Newest content intact.
        let list = history_list_blocking(r.clone(), u32::MAX as u32, 0).unwrap();
        assert_eq!(list.len() as usize, K);
        let newest_content =
            history_file_at_blocking(r, list[0].id.clone(), "main.tex".into()).unwrap();
        assert_eq!(newest_content, format!("content v{}", created - 1));
        // Every surviving commit was rebuilt → ids differ from pre-compact ids.
        assert!(!list.iter().any(|s| ids.contains(&s.id)));
        // Temp ref cleaned up.
        assert!(repo.find_reference(COMPACT_TMP_REF).is_err());
    }

    #[test]
    fn compaction_preserves_labels_and_their_content() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // Label an early snapshot that falls well outside the newest window.
        for i in 0..(T + 10) {
            let content = if i == 2 {
                "the labeled v2 state".to_string()
            } else {
                format!("content v{i}")
            };
            fs::write(dir.path().join("main.tex"), &content).unwrap();
            let snap = history_snapshot_blocking(r.clone(), format!("snap {i}"))
                .unwrap()
                .unwrap();
            if i == 2 {
                history_add_label_blocking(r.clone(), snap.id.clone(), "keep-me".into())
                    .unwrap();
            }
        }

        let repo = open_repo(&r).unwrap();
        let (_, map) = compact_repo_with(&repo, T, K).unwrap().unwrap();

        // Label resolves and reads the exact historical content.
        let reference = repo
            .find_reference("refs/tags/keep-me")
            .expect("label must survive");
        let target = reference.target().expect("lightweight tag");
        assert!(
            map.values().any(|new_oid| *new_oid == target),
            "label must point into the rebuilt chain"
        );
        let commit = repo.find_commit(target).unwrap();
        let entry = commit.tree().unwrap().get_path(Path::new("main.tex")).unwrap();
        let blob = repo.find_blob(entry.id()).unwrap();
        assert_eq!(
            String::from_utf8_lossy(blob.content()),
            "the labeled v2 state"
        );

        // The label appears in the listing.
        let list = history_list_blocking(r, 1000, 0).unwrap();
        assert!(list.iter().any(|s| s.labels.contains(&"keep-me".into())));
    }

    #[test]
    fn compaction_is_idempotent_and_converges() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        build_history(&dir, T + 10);

        let repo = open_repo(&r).unwrap();
        let first = compact_repo_with(&repo, T, K).unwrap().unwrap().0;
        let size_after_first = count_commits_capped(&repo, usize::MAX).unwrap();

        // Second run: at/below threshold → no-op.
        let second = compact_repo_with(&repo, T, K).unwrap();
        assert!(second.is_none());
        assert_eq!(
            count_commits_capped(&repo, usize::MAX).unwrap(),
            size_after_first
        );
        assert_eq!(first.after, size_after_first);
    }

    #[test]
    fn compaction_preserves_timestamp_ordering_for_listing() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        build_history(&dir, T + 10);

        let repo = open_repo(&r).unwrap();
        compact_repo_with(&repo, T, K).unwrap().unwrap();

        let list = history_list_blocking(r, 1000, 0).unwrap();
        for pair in list.windows(2) {
            assert!(
                pair[0].timestamp >= pair[1].timestamp,
                "ordering broke: {} < {}",
                pair[0].timestamp,
                pair[1].timestamp
            );
        }
    }

    #[test]
    fn compaction_refuses_merge_history_without_touching_anything() {
        let dir = setup_project(&[("a.tex", "a"), ("b.tex", "b")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        // Hand-craft a merge to simulate foreign writes to this repo.
        {
            let repo = open_repo(&r).unwrap();
            let sig = default_signature().unwrap();
            let tip = repo.head().unwrap().peel_to_commit().unwrap();

            fs::write(dir.path().join("branch-file.tex"), "from branch").unwrap();
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let side_tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let side = repo
                .commit(Some("refs/heads/side"), &sig, &sig, "side", &side_tree, &[&tip])
                .unwrap();
            let side_commit = repo.find_commit(side).unwrap();

            fs::write(dir.path().join("a.tex"), "merged").unwrap();
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let merge_tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                "merge",
                &merge_tree,
                &[&tip, &side_commit],
            )
            .unwrap();
        }

        build_history(&dir, T + 5);

        let before_list = history_list_blocking(r.clone(), u32::MAX as u32, 0).unwrap();
        let err = compact_repo_with(&open_repo(&r).unwrap(), T, K)
            .err()
            .expect("merge history must be refused");
        assert!(err.contains("merge"), "got: {err}");

        // Untouched: same length, same tip id.
        let after_list = history_list_blocking(r, u32::MAX as u32, 0).unwrap();
        assert_eq!(before_list.len(), after_list.len());
        assert_eq!(before_list[0].id, after_list[0].id);
    }

    #[test]
    fn compaction_refuses_annotated_tags_and_leaves_them_intact() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        let repo = open_repo(&r).unwrap();
        let tip_id = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.tag(
            "annotated",
            repo.find_commit(tip_id).unwrap().as_object(),
            &default_signature().unwrap(),
            "note",
            false,
        )
        .unwrap();
        drop(repo);

        build_history(&dir, T + 10);

        let repo = open_repo(&r).unwrap();
        let head_before = repo.head().unwrap().target();
        let err = compact_repo_with(&repo, T, K)
            .err()
            .expect("annotated tag must be refused");
        assert!(err.contains("annotated"), "got: {err}");
        assert_eq!(
            repo.head().unwrap().target(),
            head_before,
            "refusal must not mutate HEAD"
        );
        // The annotated tag still resolves.
        assert!(repo.find_reference("refs/tags/annotated").is_ok());
    }

    #[test]
    fn compaction_leaves_working_tree_untouched() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        build_history(&dir, T + 10);

        fs::write(dir.path().join("uncommitted-notes.tex"), "draft").unwrap();

        let repo = open_repo(&r).unwrap();
        compact_repo_with(&repo, T, K).unwrap().unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("uncommitted-notes.tex")).unwrap(),
            "draft",
            "compaction must never touch the working tree"
        );
        // And normal operation continues afterwards.
        let snap = history_snapshot_blocking(r.clone(), "post-compact save".into())
            .unwrap()
            .expect("post-compaction snapshot works");
        assert!(snap.changed_files.contains(&"uncommitted-notes.tex".into()));
    }

    #[test]
    fn compaction_survives_a_stale_temp_ref() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();
        build_history(&dir, T + 10);

        // Simulate a crashed earlier attempt leaving the temp ref behind.
        {
            let repo = open_repo(&r).unwrap();
            let tip_id = repo.head().unwrap().peel_to_commit().unwrap().id();
            repo.reference(COMPACT_TMP_REF, tip_id, true, "simulated crash leftover")
                .unwrap();
        }

        let repo = open_repo(&r).unwrap();
        let result = compact_repo_with(&repo, T, K);
        assert!(result.is_ok(), "stale temp ref must not block compaction");
        result.unwrap().unwrap();
        assert!(repo.find_reference(COMPACT_TMP_REF).is_err());
    }

    /// Integration test with production constants: crossing the real threshold
    /// inside `history_snapshot_blocking` must auto-compact and remap the id it
    /// returns so callers never hold a dangling reference.
    #[test]
    fn auto_compaction_remaps_snapshot_id_so_callers_stay_valid() {
        let dir = setup_project(&[("main.tex", "v")]);
        let r = root(&dir);
        history_init_blocking(r.clone()).unwrap();

        for i in 0..super::COMPACT_THRESHOLD - 2 {
            fs::write(
                dir.path().join("main.tex"),
                format!("content v{i}"),
            )
            .unwrap();
            history_snapshot_blocking(r.clone(), format!("fill {i}")).unwrap().unwrap();
        }
        // This one crosses the threshold and triggers auto-compaction.
        fs::write(dir.path().join("main.tex"), "final content").unwrap();
        let snap = history_snapshot_blocking(r.clone(), "crossing snapshot".into())
            .unwrap()
            .expect("snapshot created");

        let content =
            history_file_at_blocking(r.clone(), snap.id.clone(), "main.tex".into())
                .expect("returned id must survive compaction");
        assert_eq!(content, "final content");

        let repo = open_repo(&r).unwrap();
        let count = count_commits_capped(&repo, usize::MAX).unwrap();
        assert!(count <= super::COMPACT_KEEP_UNLABELED + 1);
    }
}
