# MCP Résumé Harness

How an external agent drives DevPrism's résumé generator, and what it costs.

## The problem this solves

The canonical résumé pipeline is TypeScript (`src/lib/resume-synthesis/`) and
runs in the webview. The MCP server does not: `main.rs --mcp` builds a Tokio
runtime, a `CareerDbState`, and the plugin registry — no Tauri app, no webview,
no JS engine. It therefore cannot call the TypeScript.

Before this work it didn't try. The seven `resume_*` analysis tools were self-contained
heuristics that had drifted into fiction (`resume_ats_check` — an ATS parse
simulation, keyword heatmap, and JD metadata audit ported from IgniteCV — later
joined them as the eighth):

| Tool | What it claimed | What it did |
| --- | --- | --- |
| `resume_rewrite_bullets` | "strict anti-hallucination provenance" | `let tailored = bullet.canonical.clone()` — rewrote nothing, then reported `provenanceVerified: true, hasHallucination: false` hardcoded |
| `resume_finetune_bullet` | "metric impact" | Appended a **fabricated** `"(impact: improved latency/efficiency by 25%)"` to any bullet without a number |
| `resume_compile` (LaTeX) | "compile" | Returned `success: true, "LaTeX source verified"` without compiling |
| `resume_synthesize` | "7-stage pipeline" | `generate_mock_typst_resume`, first 3 blocks, hardcoded `coveragePercentage: 88.0` |
| `resume_score_and_select` | "knapsack + MMR" | A greedy sort; its bullet term asked whether the JD contained an entire résumé bullet verbatim (always false) |
| `resume_gap_analysis` | skill coverage | `a.contains(b) \|\| b.contains(a)` — "Go" matched "Django" |

`generate_mock_typst_resume` also interpolated bullet text straight into Typst
**markup**, where `#` opens code mode — the shape
`career_typst::engine`'s `markup_splicing_is_unsafe_which_is_why_we_use_code_mode`
test exists to forbid.

## Architecture

```
MCP client (Claude Code / kon / any agent)
        │  JSON-RPC over stdio or HTTP
        ▼
  mcp/tools_resume.rs        ← thin dispatch, computes nothing
        │
        ▼
  career_match/              ← deterministic core, ported from TypeScript
    jd.rs           JdProfile: lexicon extraction, or normalise a model's JSON
    scoring.rs      0.40 embedding + 0.30 skills + 0.15 persona
                    + 0.10 recency + 0.05 seniority
    selection.rs    knapsack + per-section caps + one-per-org + coverage
                    repair; mmr_select is a primitive, not part of packing
    metrics.rs      metric preservation AND fabrication detection
    gap.rs          must-have coverage and ATS percentage
    text.rs         skill normalisation and word-boundary matching
    typst_escape.rs NFC + plain text → Typst string literals
    render.rs       document assembly + rendered-literal audit
        │
        ▼
  career_typst::engine       ← sandboxed in-process Typst → PDF
```

The TypeScript remains the canonical owner. `career_match` is a faithful port;
each module names its counterpart, and every deliberate divergence is documented
at its definition and pinned by a test.

## Who supplies the language

**This server contains no model and makes no model calls.** Only two of the
seven stages need one — JD analysis and bullet rewriting — and for both, the
language comes from the caller. Everything else is deterministic Rust.

That is a deliberate contract, not a gap. An MCP client is almost always an
agent that already has a model, so a second model inside the server would
duplicate what the caller brings while adding outbound network calls, model
configuration and timeouts to a headless process.

* **JD analysis.** `resume_analyze_jd` extracts deterministically from a
  controlled vocabulary and reports `extractionMethod: "heuristic"` plus a
  warning when the JD is too short or nothing matched. A caller with a model
  can produce a better profile itself; `career_match::jd::normalize` coerces
  arbitrary model JSON into the canonical `JdProfile` shape.
* **Bullet rewriting.** `resume_rewrite_bullets` does not generate text. Called
  without `drafts` it returns a work order — each bullet's canonical text and
  the JD keywords it should target — and reports `provenanceVerified: false`,
  because nothing was verified. Called with `drafts`, every draft is checked
  and the canonical text is substituted on failure.

### The invariant that makes that safe

One gate applies to every candidate bullet, whatever produced it — a local
model, a frontier model, or a hand-typed string. A draft is accepted only if:

1. it is not locked,
2. every ground-truth metric survives (`25%` may become `25 percent`, but not `125%`),
3. **it introduces no figure** absent from the canonical text and its declared
   metrics (`metrics::introduced_numbers`),
4. it fits the character budget.

A failing draft is replaced by the canonical bullet and the reason is reported
in `droppedMetrics`. The floor is the user's own verified text, so a weak model
cannot lower factual quality — only tailoring quality. Drafts naming a bullet
id that is not in the block are rejected outright, never accepted on the
caller's word.

### The agent loop

```
resume_analyze_jd         → JdProfile + extractionMethod (or send your own)
                            + deterministic metadata (salary, benefits,
                            culture signals, experience level)
resume_score_and_select   → which blocks and bullets matter, with components
resume_rewrite_bullets    → without drafts: a work order listing each bullet's
                            protected metrics
  (you write the bullets)
resume_rewrite_bullets    → with drafts: accept/reject per bullet, with
                            droppedMetrics
resume_synthesize         → compiled PDF + measured match report + ATS parse
                            check over what it renders
resume_ats_check          → standalone ATS parse simulation (sections, contact
                            survival, formatting hazards) with an optional
                            JD keyword heatmap
resume_save_synthesis     → persist the result as a tailored version of your
                            master (see Plugins 1.0, below)
```

## Editing documents, not just generating them

Everything above is read-only over your files. The `resume-documents` plugin
pack (Plugins 1.0 — see `docs/PLUGINS.md`) adds the write side: an agent can
list registered projects, read a resume's Typst source, apply verified
surgical edits (`expected_sha1` optimistic concurrency, backups, atomic
writes), create or delete tailored versions (delete is human-confirmed),
compile with the in-process engine, and persist synthesis output as a new
variant. Masters are never modified by synthesis; every destructive step is
gated and reported.

## Appendix: local-model evaluation of a path that is NOT in the tree

> **Not implemented.** A prototype `career_match::language` drove Ollama from
> inside the server (`language: {"mode": "ollama"}`). It is not part of this
> codebase: it duplicated the metric verification `resume_rewrite_bullets`
> already performs, and its model interaction could not be tested without a
> live Ollama, so it was dropped rather than merged. The source is recoverable
> from the `pre-merge-main` tag.
>
> The measurements below are kept because the two tuning findings are the
> valuable part, and they would apply to any future in-server model path. Treat
> the `language:` arguments in this section as describing the prototype, not
> the current tool surface.

Measured on an **Apple M5 Pro (18-core, 64 GB)**, Ollama 0.32.13.

Per-token throughput figures are **not** reported here: with three ~18 GB
models on one machine, load/evict contention and 20–60 token outputs make
per-token rates swing by an order of magnitude between runs. The defensible
number is end-to-end wall clock of the real pipeline, one model resident at a
time — JD analysis plus a verified bullet rewrite plus Typst compilation:

| Model | Pipeline wall clock | Rewrite outcome |
| --- | --- | --- |
| `qwen3.8:27b-mlx` (27.8B, nvfp4, 18.2 GB) | **43 s** | accepted, metric preserved |
| `gemma4:e4b-it-q4_K_M` (9.6 GB) | **12 s** | accepted, metric preserved |

Both produce comparable output:

- 27B — *"Engineered a Rust and TypeScript desktop application with SQLite backend, reducing cold start latency by 40%."*
- e4b — *"Engineered a desktop application using Rust and TypeScript, integrating SQLite to cut cold start by 40%."*

### Two tuning findings that mattered more than model choice

**1. Thinking was on by default.** Ollama omits the `think` field when unset,
which lets the *model's* default apply — and Qwen3.5 defaults to thinking on.
A JD extraction spent 567 characters of reasoning to produce the same JSON:
**17.1 s with thinking, 0.7 s without**. Across the whole pipeline that was
109.8 s → 28.2 s, a 3.9× reduction. `OllamaClient::with_think` can only turn
thinking *on*, so the prototype added a `without_think()` and used it for both
stages. That method was removed with the prototype — it had no other caller —
so an in-server model path would need to reintroduce it. Both prompts requested
a fixed JSON schema and the output was verified afterwards rather than trusted,
so the reasoning trace was buying nothing.

**2. One temperature does not fit both stages.** At `0.1` — correct for
extraction — both local models simply echoed the canonical bullet back. That
was reported honestly as `no-change` rather than counted as AI work, but it
meant zero tailoring. Splitting the stages (`JD_TEMPERATURE = 0.1`,
`REWRITE_TEMPERATURE = 0.45`) plus an explicit "returning the input unchanged is
a failure" instruction restored genuine rewrites on both models. Because output
is verified regardless, a higher rewrite temperature costs nothing factually.

**On multi-token prediction:** Ollama 0.32.13 exposes no draft-model or
speculative-decoding option (no CLI flag, no `OLLAMA_*` variable), and the model
advertises `completion, vision, tools, thinking` with no MTP capability. The
throughput originally reported here was a cold, thinking-on measurement, not an
MTP artifact.

### Recommendation: tier the two stages

They have different risk profiles, and this is now measured rather than assumed.

- **JD analysis has no verifier.** A wrong profile silently mis-targets the whole
  résumé, and it runs once per JD. Spend quality here.
- **Bullet rewriting is fully verified.** The worst a weak model can do is get
  rejected and fall back to your own text. Spend speed here — it runs once per
  block.

The e4b model completed the whole pipeline **3.6× faster** with comparable
output and identical safety guarantees, so it is the better default for
rewriting. The same tiering applies to the shipped design without any server
change: the caller picks the model per call, using a stronger one to build a
`JdProfile` and a cheap one to write bullet drafts.

### On `kon` and alternative harnesses

[`0xku/kon`](https://github.com/0xku/kon) is a minimal coding agent that drives
any OpenAI-compatible `/v1` endpoint. It is a *client*, not a replacement for
anything here: this MCP server is transport-agnostic, so kon, Claude Code,
Cline, Goose or LocalHarness all drive the same tools identically. Adopting kon
is a preference about the outer loop, not an architectural change.

The genuine cost lever is **which stages need an agent at all**. Scoring,
selection, gap analysis, materialization and compilation are deterministic Rust
and cost zero tokens in every mode. Only JD analysis and rewriting consume any,
and pointing those two at a local model in your own client takes them to zero
external tokens as well.

## Verifying

```bash
cd apps/desktop/src-tauri && cargo test --lib career_match
```

There are no live-model tests: the server makes no model calls, so every stage
above is exercised deterministically and the whole suite runs offline.

`cargo check` needs the wrapper toolchain for the vendored tectonic natives —
see the notes in `career_db/CLAUDE.md` and the repo's build docs.

## Note on "the LaTeX engine"

The résumé engine is **Typst only**. The LaTeX résumé path (`ats-*` templates,
`latex-escape.ts`, the bisect/repair loop, `career_verify_compile`) was removed
deliberately; `ats-single-column` / `ats-two-column` survive only as legacy id
aliases onto Typst templates. `latex.rs` (3,394 lines, Tectonic + TeX Live +
SyncTeX) still serves the separate document-editor feature and is untouched by
this work.

`resume_compile`'s `latex_source` branch was a vestige of the removed path and
has been dropped rather than wired up — wiring it would have resurrected an
architecture the project had already retired.
