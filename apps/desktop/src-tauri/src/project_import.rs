//! Import a LaTeX project from a dropped `.zip` archive.
//!
//! The Project Picker lets users drag a `.zip` onto the window; this module
//! extracts it into a fresh project folder under `~/Documents/DevPrism/<name>`
//! and returns the new path so the frontend can open it like any other project.
//!
//! Robustness notes:
//!   - zip-slip is prevented via `ZipFile::enclosed_name()` (never trusts the
//!     archive's stored path verbatim).
//!   - A single wrapper directory (the common Overleaf / `zip -r foo foo/`
//!     layout) is flattened so files land at the project root, not one level
//!     deep.
//!   - The destination name is made unique (`name`, `name-2`, …) so importing
//!     twice never clobbers an existing project.
//!   - Extraction is validated to contain at least one `.tex`/`.ltx` file;
//!     otherwise the half-written folder is removed and an error is returned.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Refuse pathological archives (zip bombs) before they fill the disk. These
/// ceilings are far above any real LaTeX project yet small enough to fail fast.
const MAX_ENTRIES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB uncompressed

#[derive(serde::Serialize)]
pub struct ImportedProject {
    pub path: String,
    pub name: String,
}

/// Turn an arbitrary string into a safe single-segment folder name.
fn sanitize_project_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            // Reject path separators and characters illegal on Windows/macOS.
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "latex-project".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Pick a not-yet-existing directory: `base/name`, else `base/name-2`, …
fn unique_dir(base: &Path, name: &str) -> PathBuf {
    let first = base.join(name);
    if !first.exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = base.join(format!("{}-{}", name, n));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// If every entry lives under one common top-level directory, return that
/// directory's name so it can be stripped during extraction. Returns `None`
/// when files exist at the archive root (nothing to flatten).
fn single_root_prefix(names: &[String]) -> Option<String> {
    let mut root: Option<String> = None;
    let mut saw_child = false;

    for raw in names {
        let name = raw.trim_start_matches('/');
        if name.is_empty() {
            continue;
        }
        // Ignore common junk that would otherwise defeat flattening.
        let top = name.split('/').next().unwrap_or("");
        if top.is_empty() || top == "__MACOSX" {
            continue;
        }
        match &root {
            None => root = Some(top.to_string()),
            Some(existing) if existing != top => return None,
            _ => {}
        }
        // Does this entry go deeper than the top-level segment itself?
        if name.len() > top.len() {
            saw_child = true;
        }
    }

    match root {
        Some(r) if saw_child => Some(r),
        _ => None,
    }
}

/// Recursively check whether `dir` contains any `.tex`/`.ltx` file.
fn contains_tex(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if contains_tex(&path) {
                return true;
            }
        } else if matches!(
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .as_deref(),
            Some("tex" | "ltx")
        ) {
            return true;
        }
    }
    false
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open archive: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip archive: {}", e))?;

    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "Archive has too many entries ({}); refusing to extract.",
            archive.len()
        ));
    }

    let names: Vec<String> = archive.file_names().map(|n| n.to_string()).collect();
    let strip = single_root_prefix(&names);

    let mut total_bytes: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        // `enclosed_name` rejects absolute paths and `..` traversal (zip-slip).
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };

        // Skip macOS resource-fork noise.
        if enclosed
            .components()
            .any(|c| c.as_os_str() == "__MACOSX")
        {
            continue;
        }

        // Flatten the single wrapper directory if present.
        let relative = match &strip {
            Some(prefix) => match enclosed.strip_prefix(prefix) {
                Ok(stripped) => stripped.to_path_buf(),
                Err(_) => enclosed.clone(),
            },
            None => enclosed.clone(),
        };
        if relative.as_os_str().is_empty() {
            continue;
        }

        let out_path = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        } else {
            total_bytes = total_bytes.saturating_add(entry.size());
            if total_bytes > MAX_TOTAL_BYTES {
                return Err("Archive is too large to import.".to_string());
            }
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            let mut out = fs::File::create(&out_path)
                .map_err(|e| format!("Failed to write extracted file: {}", e))?;
            io::copy(&mut entry, &mut out)
                .map_err(|e| format!("Failed to extract file: {}", e))?;
        }
    }

    Ok(())
}

fn import_zip_blocking(zip_path: &str) -> Result<ImportedProject, String> {
    let zip = Path::new(zip_path);
    if !zip.is_file() {
        return Err("Dropped item is not a file.".to_string());
    }

    let home = dirs::home_dir().ok_or_else(|| "Could not locate the home directory.".to_string())?;
    let base = home.join("Documents").join("DevPrism");
    fs::create_dir_all(&base)
        .map_err(|e| format!("Failed to create the DevPrism projects folder: {}", e))?;

    let stem = zip
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("latex-project");
    let name = sanitize_project_name(stem);
    let dest = unique_dir(&base, &name);

    fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create the project folder: {}", e))?;

    if let Err(err) = extract_zip(zip, &dest) {
        let _ = fs::remove_dir_all(&dest);
        return Err(err);
    }

    if !contains_tex(&dest) {
        let _ = fs::remove_dir_all(&dest);
        return Err("The archive does not contain any LaTeX (.tex) files.".to_string());
    }

    let final_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .to_string();

    Ok(ImportedProject {
        path: dest.to_string_lossy().to_string(),
        name: final_name,
    })
}

/// Extract a dropped `.zip` LaTeX project into a new folder under
/// `~/Documents/DevPrism` and return the created project path.
#[tauri::command]
pub async fn import_zip_project(zip_path: String) -> Result<ImportedProject, String> {
    tokio::task::spawn_blocking(move || import_zip_blocking(&zip_path))
        .await
        .map_err(|e| format!("Import task failed: {}", e))?
}

/// Remaining headroom while copying loose files, so a stray drop of a giant
/// directory can't silently copy gigabytes.
struct CopyBudget {
    entries: usize,
    bytes: u64,
}

fn is_tex_file(path: &Path) -> bool {
    path.is_file()
        && matches!(
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .as_deref(),
            Some("tex" | "ltx")
        )
}

/// Copy a dropped file (or recursively a dropped folder, e.g. `figures/`) into
/// the new project, preserving its base name so relative `\input`/`\includegraphics`
/// paths keep working.
fn copy_item(src: &Path, dest_dir: &Path, budget: &mut CopyBudget) -> Result<(), String> {
    let Some(name) = src.file_name() else {
        return Ok(()); // Skip rootless paths like "/".
    };
    let target = dest_dir.join(name);

    if src.is_dir() {
        fs::create_dir_all(&target)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
        let entries =
            fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))?;
        for entry in entries.flatten() {
            copy_item(&entry.path(), &target, budget)?;
        }
    } else if src.is_file() {
        if budget.entries == 0 {
            return Err("Too many files to import.".to_string());
        }
        budget.entries -= 1;
        let size = src.metadata().map(|m| m.len()).unwrap_or(0);
        if size > budget.bytes {
            return Err("The dropped files are too large to import.".to_string());
        }
        budget.bytes -= size;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        fs::copy(src, &target).map_err(|e| format!("Failed to copy file: {}", e))?;
    }

    Ok(())
}

fn import_loose_blocking(paths: &[String]) -> Result<ImportedProject, String> {
    let sources: Vec<PathBuf> = paths
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    if sources.is_empty() {
        return Err("Nothing to import.".to_string());
    }

    // A project needs at least one LaTeX file among the dropped items.
    let Some(tex) = sources.iter().find(|p| is_tex_file(p)) else {
        return Err("Drop at least one LaTeX (.tex) file to create a project.".to_string());
    };

    let home =
        dirs::home_dir().ok_or_else(|| "Could not locate the home directory.".to_string())?;
    let base = home.join("Documents").join("DevPrism");
    fs::create_dir_all(&base)
        .map_err(|e| format!("Failed to create the DevPrism projects folder: {}", e))?;

    // Name the project after the LaTeX file, unless it's a generic stem that
    // would collide across many projects.
    let raw_stem = tex
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("latex-project");
    let stem = match raw_stem.to_ascii_lowercase().as_str() {
        "main" | "document" => "latex-project",
        _ => raw_stem,
    };
    let name = sanitize_project_name(stem);
    let dest = unique_dir(&base, &name);
    fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create the project folder: {}", e))?;

    let mut budget = CopyBudget {
        entries: MAX_ENTRIES,
        bytes: MAX_TOTAL_BYTES,
    };
    for src in &sources {
        if let Err(err) = copy_item(src, &dest, &mut budget) {
            let _ = fs::remove_dir_all(&dest);
            return Err(err);
        }
    }

    if !contains_tex(&dest) {
        let _ = fs::remove_dir_all(&dest);
        return Err("The dropped files do not contain any LaTeX (.tex) files.".to_string());
    }

    let final_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .to_string();

    Ok(ImportedProject {
        path: dest.to_string_lossy().to_string(),
        name: final_name,
    })
}

/// Create a new project under `~/Documents/DevPrism` from loose dropped files
/// (a bare `main.tex`, plus optional `.bib`, images, and figure folders) and
/// return the created project path.
#[tauri::command]
pub async fn import_loose_files(paths: Vec<String>) -> Result<ImportedProject, String> {
    tokio::task::spawn_blocking(move || import_loose_blocking(&paths))
        .await
        .map_err(|e| format!("Import task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_unsafe_names() {
        assert_eq!(sanitize_project_name("my paper"), "my paper");
        assert_eq!(sanitize_project_name("a/b:c"), "a-b-c");
        assert_eq!(sanitize_project_name("   "), "latex-project");
        assert_eq!(sanitize_project_name("..."), "latex-project");
    }

    #[test]
    fn detects_single_root_wrapper() {
        let names = vec![
            "thesis/".to_string(),
            "thesis/main.tex".to_string(),
            "thesis/chapters/intro.tex".to_string(),
        ];
        assert_eq!(single_root_prefix(&names), Some("thesis".to_string()));
    }

    #[test]
    fn no_flatten_when_files_at_root() {
        let names = vec![
            "main.tex".to_string(),
            "refs.bib".to_string(),
            "figures/plot.png".to_string(),
        ];
        assert_eq!(single_root_prefix(&names), None);
    }

    #[test]
    fn no_flatten_with_multiple_roots() {
        let names = vec![
            "a/main.tex".to_string(),
            "b/extra.tex".to_string(),
        ];
        assert_eq!(single_root_prefix(&names), None);
    }

    #[test]
    fn ignores_macosx_when_flattening() {
        let names = vec![
            "__MACOSX/".to_string(),
            "paper/main.tex".to_string(),
        ];
        assert_eq!(single_root_prefix(&names), Some("paper".to_string()));
    }

    #[test]
    fn extracts_flattens_and_validates() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("paper.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            writer.start_file("paper/main.tex", opts).unwrap();
            writer.write_all(b"\\documentclass{article}").unwrap();
            writer.start_file("paper/refs.bib", opts).unwrap();
            writer.write_all(b"@book{x}").unwrap();
            writer.finish().unwrap();
        }

        let dest = tmp.path().join("out");
        fs::create_dir_all(&dest).unwrap();
        extract_zip(&zip_path, &dest).unwrap();

        // The single "paper/" wrapper is flattened to the project root.
        assert!(dest.join("main.tex").is_file());
        assert!(dest.join("refs.bib").is_file());
        assert!(!dest.join("paper").exists());
        assert!(contains_tex(&dest));
    }

    #[test]
    fn copies_loose_files_and_figure_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let figures = src.join("figures");
        fs::create_dir_all(&figures).unwrap();
        fs::write(src.join("main.tex"), b"\\documentclass{article}").unwrap();
        fs::write(src.join("refs.bib"), b"@book{x}").unwrap();
        fs::write(figures.join("plot.png"), b"PNG").unwrap();

        let dest = tmp.path().join("out");
        fs::create_dir_all(&dest).unwrap();
        let mut budget = CopyBudget {
            entries: MAX_ENTRIES,
            bytes: MAX_TOTAL_BYTES,
        };
        for item in ["main.tex", "refs.bib", "figures"] {
            copy_item(&src.join(item), &dest, &mut budget).unwrap();
        }

        assert!(dest.join("main.tex").is_file());
        assert!(dest.join("refs.bib").is_file());
        // The figure folder is copied recursively, preserving relative paths.
        assert!(dest.join("figures").join("plot.png").is_file());
        assert!(contains_tex(&dest));
    }

    #[test]
    fn rejects_loose_drop_without_tex() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("notes.txt"), b"hi").unwrap();
        let paths = vec![tmp.path().join("notes.txt").to_string_lossy().to_string()];
        assert!(import_loose_blocking(&paths).is_err());
    }
}
