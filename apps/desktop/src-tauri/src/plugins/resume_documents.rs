//! Pack: resume document editing (`resume_doc_*` / `resume_variant_*` tools).
//!
//! This is the capability that lets an external agent *edit or modify the
//! user's actual resume documents* through DevPrism's engine — master project
//! files and tailored variants under `<project>/.prism/variants/` — instead of
//! only generating fresh synthesis output in-band.
//!
//! # Safety model
//!
//! * **Known-project gate.** Every path argument is validated against the
//!   `known_projects` table in `career.db` (written by the desktop app when a
//!   project is opened). An agent cannot point these tools at an arbitrary
//!   directory; unknown roots are refused with guidance.
//! * **Confinement.** All file access goes through `super::path_guard::confine`
//!   — no `..`, no absolute paths outside the root, no symlink escapes.
//! * **Read-before-write.** Overwrites require `expected_sha1` to match the
//!   current file (optimistic concurrency), so a stale writer clobber nothing.
//! * **Major-reduction guard.** A write/edit removing more than half of a
//!   non-trivial file is refused unless `allow_major_reduction: true`.
//! * **Backups.** Every destructive overwrite copies prior content to
//!   `.prism/mcp-backups/<ts>/<rel>` and reports where; failures abort.
//! * **Human confirmation.** Variant deletion uses the same single-use,
//!   tool+subject-bound MRTR elicitation as `career_delete_block`.
//! * **Atomicity.** Writes go through temp-file + rename.
//!
//! Execution lives in [`exec`] so this file stays declarations + routing.

use super::{BoxedToolFuture, CapabilityPlugin, PluginContext};
use crate::mcp::protocol::{
    JsonRpcError, PromptArgument, PromptDefinition, ResourceDefinition, ResponseMeta,
    ToolDefinition,
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub mod exec;

pub struct ResumeDocumentsPlugin;

impl CapabilityPlugin for ResumeDocumentsPlugin {
    fn id(&self) -> &'static str {
        "resume-documents"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "Edit resume documents: read/write/edit master files and tailored variants, compile to PDF, persist synthesis output."
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        let meta = || Some(ResponseMeta::default());
        vec![
            ToolDefinition {
                name: "resume_doc_list_projects".to_string(),
                description: "List workspace projects registered with DevPrism — the only roots these document tools may touch. Read-only.".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_doc_list_files".to_string(),
                description: "List source files of a registered project (relative paths + sizes). Dot-directories like .prism/.git are excluded; use resume_variant_list for tailored versions. Read-only.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "project_root": { "type": "string" } },
                    "required": ["project_root"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_doc_read".to_string(),
                description: "Read a UTF-8 text file from a registered project. Returns content plus its sha1 — pass that sha1 as expected_sha1 to later writes/edits so concurrent changes cannot be clobbered. Read-only.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "file_path": { "type": "string", "description": "Project-relative path" }
                    },
                    "required": ["project_root", "file_path"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_doc_write".to_string(),
                description: "Create or overwrite a text file (.typ .tex .md .txt .json .yaml .yml .bib .cls .sty .csv) in a registered project. Overwriting requires expected_sha1 from a prior read; the previous content is backed up under .prism/mcp-backups; reducing a non-trivial file by more than half additionally needs allow_major_reduction=true.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "file_path": { "type": "string" },
                        "content": { "type": "string" },
                        "expected_sha1": { "type": "string", "description": "sha1 of current content (from resume_doc_read); required when overwriting" },
                        "allow_major_reduction": { "type": "boolean", "description": "Set true to allow replacing >50% of a non-trivial file" }
                    },
                    "required": ["project_root", "file_path", "content"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_doc_edit".to_string(),
                description: "Apply several exact-string edits to ONE file atomically (all-or-nothing: every edit must match or nothing is written). Requires expected_sha1 from a prior read; backs up the original. Prefer over full-file rewrite.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "file_path": { "type": "string" },
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "old_string": { "type": "string" },
                                    "new_string": { "type": "string" },
                                    "replace_all": { "type": "boolean" }
                                },
                                "required": ["old_string", "new_string"]
                            }
                        },
                        "expected_sha1": { "type": "string" },
                        "allow_major_reduction": { "type": "boolean" }
                    },
                    "required": ["project_root", "file_path", "edits", "expected_sha1"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_variant_list".to_string(),
                description: "List tailored versions (variants) of a registered master project. Accepts a master or variant path. Read-only.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "project_root": { "type": "string" } },
                    "required": ["project_root"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_variant_create".to_string(),
                description: "Snapshot the master's sources into <project>/.prism/variants/<slug>/ as a new tailored version. Additive; never touches the master.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "name": { "type": "string", "description": "Human-facing version name" },
                        "jd_text": { "type": "string", "description": "Target job description, stored as JOB_DESCRIPTION.md" },
                        "status": { "type": "string", "description": "Pipeline state, default 'draft'" }
                    },
                    "required": ["project_root", "name"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_variant_update".to_string(),
                description: "Update a variant's display name, pipeline status, or job description. Does not touch document sources.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "variant_id": { "type": "string" },
                        "name": { "type": "string" },
                        "status": { "type": "string" },
                        "jd_text": { "type": "string" }
                    },
                    "required": ["project_root", "variant_id"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_variant_delete".to_string(),
                description: "Delete a tailored version folder permanently. Requires human confirmation via MRTR: call without request_state to receive an inputRequired confirmation, have the user approve, then re-call passing request_state and input_responses.confirm=true.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "variant_id": { "type": "string" },
                        "request_state": { "type": "string", "description": "Confirmation state returned by the earlier inputRequired result" },
                        "input_responses": {
                            "type": "object",
                            "properties": { "confirm": { "type": "boolean" } }
                        }
                    },
                    "required": ["project_root", "variant_id"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_variant_diff".to_string(),
                description: "Diff a variant against its master file by file (added/modified/deleted, with contents). Read-only.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "variant_id": { "type": "string" }
                    },
                    "required": ["project_root", "variant_id"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_compile_file".to_string(),
                description: "Compile a Typst resume from a registered project with the in-process engine. Defaults to the detected main .typ source. pdfBase64 only when include_pdf=true (default false: PDF bytes flood agent context); persist_pdf=true also writes <root>/.prism/build/<stem>.pdf.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string" },
                        "file_path": { "type": "string", "description": "Project-relative .typ source; defaults to the main source" },
                        "include_pdf": { "type": "boolean" },
                        "persist_pdf": { "type": "boolean" }
                    },
                    "required": ["project_root"]
                }),
                _meta: meta(),
            },
            ToolDefinition {
                name: "resume_save_synthesis".to_string(),
                description: "Persist generated Typst resume source as a NEW tailored version of a registered master: creates the variant snapshot, replaces the variant's main Typst file with the given source, compiles a verification PDF into the variant's .prism/build/, and records the JD text. The master is never modified.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "project_root": { "type": "string", "description": "Master project root" },
                        "version_name": { "type": "string" },
                        "typst_source": { "type": "string" },
                        "jd_text": { "type": "string" },
                        "status": { "type": "string", "description": "Default 'draft'" }
                    },
                    "required": ["project_root", "version_name", "typst_source"]
                }),
                _meta: meta(),
            },
        ]
    }

    fn resources(&self) -> Vec<ResourceDefinition> {
        vec![ResourceDefinition {
            uri: "resume-docs://projects".to_string(),
            name: "Registered projects".to_string(),
            description: Some(
                "Workspace projects the resume-document tools may operate on.".to_string(),
            ),
            mime_type: Some("application/json".to_string()),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(10_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        }]
    }

    fn prompts(&self) -> Vec<PromptDefinition> {
        vec![PromptDefinition {
            name: "edit-resume-with-engine".to_string(),
            description: Some(
                "Guided workflow for editing the user's resume documents with DevPrism's engine."
                    .to_string(),
            ),
            arguments: vec![
                PromptArgument {
                    name: "instruction".to_string(),
                    description: Some("What the user wants changed".to_string()),
                    required: true,
                },
                PromptArgument {
                    name: "project_root".to_string(),
                    description: Some("Optional known project path; discovered when omitted".to_string()),
                    required: false,
                },
            ],
            _meta: None,
        }]
    }

    fn call_tool<'a>(
        &'a self,
        ctx: &'a PluginContext,
        name: &'a str,
        args: &'a Value,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move { exec::execute(ctx, name, args).await })
    }

    fn read_resource<'a>(&'a self, ctx: &'a PluginContext, uri: &'a str) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            if uri != "resume-docs://projects" {
                return Err(JsonRpcError::method_not_found(uri));
            }
            let db = ctx.career_db.clone();
            tokio::task::spawn_blocking(move || {
                db.with_conn(crate::career_db::list_known_projects_blocking)
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
            .map(|projects| {
                serde_json::json!({
                    "contents": [{
                        "uri": uri,
                        "mimeType": "application/json",
                        "text": serde_json::to_string(&projects)
                            .unwrap_or_else(|_| "[]".to_string()),
                    }]
                })
            })
            .map_err(JsonRpcError::internal_error)
        })
    }

    fn get_prompt<'a>(
        &'a self,
        _ctx: &'a PluginContext,
        name: &'a str,
        args: &'a std::collections::HashMap<String, String>,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            if name != "edit-resume-with-engine" {
                return Err(JsonRpcError::method_not_found(name));
            }
            let instruction = args.get("instruction").cloned().unwrap_or_default();
            let project = args.get("project_root").cloned();
            let project_line = project
                .map(|p| format!("Project root: {p}\n"))
                .unwrap_or_else(|| {
                    "Project root: not specified — call resume_doc_list_projects first.\n"
                        .to_string()
                });
            Ok(json!({
                "description": "Edit the user's resume with DevPrism's engine",
                "messages": [{
                    "role": "user",
                    "content": { "type": "text", "text": format!(
"Edit my resume documents per this instruction:\n\n=== INSTRUCTION ===\n{instruction}\n\n{project_line}\nWorkflow:\n1. resume_doc_list_projects → pick the project (variants are allowed too).\n2. resume_doc_list_files / resume_variant_list → orient yourself.\n3. resume_doc_read every file you will change; keep each returned sha1.\n4. Make changes with resume_doc_edit (preferred) or resume_doc_write; pass the matching expected_sha1. For a fresh targeted version of the master, use resume_variant_create or resume_save_synthesis instead of editing the master.\n5. Verify with resume_compile_file before reporting success; report diagnostics verbatim on failure.\nNever invent metrics or employers; only edit what the instruction covers."
                    ) }
                }]
            }))
        })
    }

    fn native_agent_tools(&self) -> &'static [&'static str] {
        &[
            "resume_doc_list_projects",
            "resume_doc_list_files",
            "resume_doc_read",
            "resume_doc_edit",
            "resume_doc_write",
            "resume_variant_list",
            "resume_variant_create",
            "resume_compile_file",
            "resume_save_synthesis",
        ]
    }
}
