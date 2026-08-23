#!/usr/bin/env node
/**
 * The documentation is a declaration layer, and nothing was checking it.
 *
 * A sentence stating a count compiles no matter what the count is, and goes on
 * reading correctly forever after the thing it counts has moved. The commit
 * before this file was titled "docs(mcp): make the resume harness doc match the
 * shipped tool surface" — drift found by hand, after it had already shipped.
 * This is that reconciliation made automatic, so the class fails here rather
 * than being rediscovered later.
 *
 * Every check re-derives a stated fact from the artifact that decides it. A
 * check whose pattern stops matching is itself a failure, so rewording a claim
 * past the guard cannot silently retire it.
 *
 * Run: pnpm docs:verify        (add --verbose to see what each check examined)
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

const errors = [];
const notes = [];

function fail(where, message) {
  errors.push(`${where}: ${message}`);
}
function note(message) {
  notes.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Every markdown document this contract governs. */
function allDocs() {
  const out = [];
  for (const dir of ["", "docs"]) {
    const abs = path.join(ROOT, dir);
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith(".md")) continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (fs.statSync(path.join(ROOT, rel)).isFile()) out.push(rel);
    }
  }
  out.sort();
  if (out.length < 20) {
    fail(
      "contract",
      `found only ${out.length} documents; this is examining almost nothing`,
    );
  }
  return out;
}

/**
 * The tool surface, with its evidence tier reported rather than assumed.
 *
 * The strong answer is the built binary's own `tools/list` — the exact thing
 * docs/PLUGINS.md tells a reader to run. When that binary has not been built
 * (its tectonic dependency needs a C++ toolchain that CI may not carry), fall
 * back to scanning the three files that literally construct the definitions.
 *
 * Which one answered is printed either way. A check that could not run at full
 * strength must never report the same result as one that did.
 */
function toolSurface() {
  const binary = path.join(
    ROOT,
    "apps/desktop/src-tauri/target/debug/claude-prism-desktop",
  );
  if (fs.existsSync(binary)) {
    try {
      const request = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })}\n`;
      const out = execFileSync(binary, ["--mcp"], {
        input: request,
        encoding: "utf8",
        timeout: 30_000,
      });
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        const msg = JSON.parse(line);
        if (msg?.result?.tools) {
          return {
            names: msg.result.tools.map((t) => t.name).sort(),
            source: "the built binary's tools/list",
            strong: true,
          };
        }
      }
    } catch (e) {
      note(
        `the built binary did not answer tools/list (${e.message.split("\n")[0]}); falling back to source`,
      );
    }
  }

  // Fallback: the three files that construct ToolDefinition values.
  const files = [
    "apps/desktop/src-tauri/src/mcp/tools_resume.rs",
    "apps/desktop/src-tauri/src/mcp/tools_career.rs",
    "apps/desktop/src-tauri/src/plugins/resume_documents.rs",
  ];
  const names = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) {
      fail(
        "contract",
        `${f} is gone; the tool-surface scan cannot see the definitions`,
      );
      continue;
    }
    const body = fs.readFileSync(abs, "utf8");
    // Only `name:` fields inside a ToolDefinition literal.
    const re = /ToolDefinition\s*\{[\s\S]*?name:\s*"([a-z0-9_]+)"/g;
    let m;
    while ((m = re.exec(body)) !== null) names.push(m[1]);
  }
  return {
    names: [...new Set(names)].sort(),
    source:
      "a source scan of the three tool-definition files (binary not built)",
    strong: false,
  };
}

/**
 * The tool count in PLUGINS.md must be the surface's count.
 *
 * `Expect 28 tools across the three packs` is the line a reader checks a live
 * tools/list against. When a pack gains a tool and that sentence does not, the
 * smoke test it documents starts reporting a failure that is not one — which is
 * how a real regression later gets waved through.
 */
function checkToolCount(surface) {
  const body = read("docs/PLUGINS.md");
  const m = body.match(/Expect (\d+) tools across the (\w+) packs/);
  if (!m) {
    fail(
      "docs/PLUGINS.md",
      "no longer states the tool count; re-point this guard at the sentence that does",
    );
    return;
  }
  const stated = Number(m[1]);
  if (stated !== surface.names.length) {
    fail(
      "docs/PLUGINS.md",
      `says ${stated} tools, ${surface.source} serves ${surface.names.length}`,
    );
  }

  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const statedPacks = words[m[2].toLowerCase()] ?? Number(m[2]);
  const packs = countPacks();
  if (Number.isFinite(statedPacks) && packs !== null && statedPacks !== packs) {
    fail(
      "docs/PLUGINS.md",
      `says ${m[2]} packs, the registry registers ${packs}`,
    );
  }
  if (VERBOSE) {
    note(
      `tool count: ${stated} stated, ${surface.names.length} from ${surface.source}`,
    );
  }
}

/** How many packs default_registry() registers. */
function countPacks() {
  const abs = path.join(ROOT, "apps/desktop/src-tauri/src/plugins/mod.rs");
  if (!fs.existsSync(abs)) return null;
  const body = fs.readFileSync(abs, "utf8");
  const fn = body.match(/pub fn default_registry\(\)[\s\S]*?\n\}/);
  if (!fn) return null;
  return (fn[0].match(/reg\.register\(/g) || []).length;
}

/**
 * Every `resume_*` / `career_*` identifier the docs name must exist in the code.
 *
 * The opposite direction of the count: a document can carry the right total and
 * still name something that was renamed out from under it. A reader following
 * that name gets `unknown tool`, which reads like their client is broken rather
 * than the doc being stale.
 *
 * The check is deliberately against the WHOLE source tree, not the MCP tool
 * registry. Its first draft compared against the registry alone and produced
 * ten findings, nine of which were correct prose: `career_upsert_kb_source` and
 * `career_typst_compile` are Tauri commands, `career_db` and `career_match` are
 * Rust modules, and a doc naming any of them is right to. A check that fires on
 * correct input is worse than no check — it teaches readers to skip the output,
 * which costs more than the class it catches.
 *
 * What survives is the real class: an identifier that exists nowhere. Genuine
 * historical references live in HISTORICAL_IDENTIFIERS with the reason, and an
 * entry that starts existing again FAILS, so the list can only describe the
 * present.
 */
const HISTORICAL_IDENTIFIERS = {
  career_verify_compile:
    "the LaTeX compile/repair loop, removed when Typst replaced it; docs/RESUME_SYNTHESIS.md and docs/MCP_RESUME_HARNESS.md describe its removal deliberately",
};

/** Every identifier defined anywhere in the desktop app's source. */
function sourceIdentifiers() {
  const roots = ["apps/desktop/src-tauri/src", "apps/desktop/src"];
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "target") continue;
        walk(abs);
        // A directory is a module name too (career_db/, career_typst/).
        found.add(entry.name);
        continue;
      }
      if (!/\.(rs|ts|tsx|js|mjs)$/.test(entry.name)) continue;
      found.add(entry.name.replace(/\.[^.]+$/, ""));
      const body = fs.readFileSync(abs, "utf8");
      for (const m of body.matchAll(/\b((?:resume|career)_[a-z0-9_]+)\b/g)) {
        found.add(m[1]);
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(ROOT, r);
    if (fs.existsSync(abs)) walk(abs);
  }
  return found;
}

function checkToolNames(docs) {
  const live = sourceIdentifiers();
  if (live.size < 50) {
    fail(
      "contract",
      `only ${live.size} identifiers found in the source; the name check examined almost nothing`,
    );
    return;
  }

  let checked = 0;
  const seenHistorical = new Set();
  for (const doc of docs) {
    const body = read(doc);
    const re = /`((?:resume|career)_[a-z0-9_]+)`/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const name = m[1];
      if (name.endsWith("_")) continue; // dispatch prefixes, not identifiers
      checked += 1;
      if (live.has(name)) continue;
      if (name in HISTORICAL_IDENTIFIERS) {
        seenHistorical.add(name);
        continue;
      }
      fail(doc, `names \`${name}\`, which exists nowhere in the source`);
    }
  }

  for (const [name, reason] of Object.entries(HISTORICAL_IDENTIFIERS)) {
    if (live.has(name)) {
      fail(
        "contract",
        `\`${name}\` is recorded as historical ("${reason}") but exists in the source again; delete the entry`,
      );
    } else if (!seenHistorical.has(name)) {
      fail(
        "contract",
        `\`${name}\` is recorded as historical but no document mentions it any more; delete the entry`,
      );
    }
  }

  if (checked < 10) {
    fail(
      "contract",
      `only ${checked} identifier references found across the docs; this is not reading them`,
    );
  }
  if (VERBOSE) {
    note(
      `identifiers: ${checked} doc references checked against ${live.size} source identifiers`,
    );
  }
}

/**
 * Translated documents must keep the structure of their original.
 *
 * This project ships four READMEs and four NATIVE_AGENT documents. A section
 * added to the English one and not the others is invisible: each translation
 * still reads as complete, and a reader in that language has no way to know a
 * capability exists. The audit that added this file found exactly that —
 * `## Native API (Groq / OpenRouter / Gemini / …)` present only in English, so
 * three of four audiences could not learn those providers are supported.
 *
 * Headings cannot be compared by text across languages, so the check is
 * structural: the same number of sections at the same depth.
 *
 * Known gaps live in ALLOWED with a reason, and an entry that no longer
 * corresponds to a real difference FAILS — an allowlist permitted to hold stale
 * excuses becomes a list nobody can read.
 */
const TRANSLATION_SETS = [
  {
    id: "README",
    original: "README.md",
    translations: ["README.ko.md", "README.ja.md", "README.zh-CN.md"],
  },
  {
    id: "docs/NATIVE_AGENT",
    original: "docs/NATIVE_AGENT.md",
    translations: [
      "docs/NATIVE_AGENT.ko.md",
      "docs/NATIVE_AGENT.ja.md",
      "docs/NATIVE_AGENT.zh-CN.md",
    ],
  },
];

const ALLOWED = {
  "docs/NATIVE_AGENT": {
    missing: 1,
    reason:
      "`## Native API (Groq / OpenRouter / Gemini / …)` is English-only; the three translations predate native API provider support",
  },
};

function sectionCount(body) {
  let fenced = false;
  let n = 0;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && line.startsWith("## ")) n += 1;
  }
  return n;
}

function checkTranslations() {
  const drifted = new Set();
  for (const set of TRANSLATION_SETS) {
    const want = sectionCount(read(set.original));
    if (want === 0) {
      fail(set.original, "has no sections; this check examined nothing");
      continue;
    }
    const excused = ALLOWED[set.id]?.missing ?? 0;
    for (const t of set.translations) {
      const got = sectionCount(read(t));
      const missing = Math.max(0, want - got);
      if (missing > 0) drifted.add(set.id);
      if (missing > excused) {
        fail(
          t,
          `has ${got} sections against ${want} in ${set.original} (${missing} missing, ${excused} excused) — ` +
            "translate the new section, or record it in ALLOWED with the reason",
        );
      }
      if (got > want) {
        fail(
          t,
          `has ${got} sections, more than the ${want} in ${set.original}; the translation carries something the original does not`,
        );
      }
    }
    if (VERBOSE)
      note(
        `${set.id}: ${want} sections, ${set.translations.length} translations`,
      );
  }

  for (const [id, entry] of Object.entries(ALLOWED)) {
    if (!drifted.has(id)) {
      fail(
        "contract",
        `${id} is allowlisted ("${entry.reason}") but no longer drifts; delete the entry`,
      );
    }
  }
}

/** Relative links must resolve. On a public repo a dead link is the first impression. */
function checkLinks(docs) {
  let checked = 0;
  for (const doc of docs) {
    const body = read(doc);
    const base = path.dirname(path.join(ROOT, doc));
    const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const target = m[2].split("#")[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      checked += 1;
      if (!fs.existsSync(path.resolve(base, target))) {
        fail(doc, `link [${m[1]}](${m[2]}) points at nothing`);
      }
    }
  }
  if (checked < 20) {
    fail(
      "contract",
      `only ${checked} relative links checked; this is not reading the docs`,
    );
  }
  if (VERBOSE) note(`links: ${checked} relative links resolved`);
}

/**
 * Mermaid diagrams must use an edge operator that exists.
 *
 * A broken diagram is worse than a missing one: the renderer replaces it with a
 * parse error. `=>` is accepted by no mermaid dialect; a bare `->` by none
 * except sequence diagrams.
 *
 * Bracket balance is deliberately NOT checked. Mermaid edge labels are free
 * text, so a balance check flags correct diagrams — and failures that fire on
 * correct input teach readers to skip the suite.
 */
function stripQuoted(s) {
  let out = "";
  let inside = false;
  for (const c of s) {
    if (c === '"') {
      inside = !inside;
      out += c;
    } else out += inside ? " " : c;
  }
  return out;
}

function checkMermaid(docs) {
  let blocks = 0;
  for (const doc of docs) {
    const lines = read(doc).split("\n");
    let inBlock = false;
    let sequence = false;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === "```mermaid") {
        inBlock = true;
        sequence = false;
        blocks += 1;
        continue;
      }
      if (inBlock && trimmed === "```") {
        inBlock = false;
        continue;
      }
      if (!inBlock) continue;
      if (trimmed.startsWith("sequenceDiagram")) sequence = true;

      const code = stripQuoted(lines[i]);
      if (/(^|[^-=<>])=>/.test(code)) {
        fail(
          `${doc}:${i + 1}`,
          `\`=>\` is not a mermaid edge operator: ${trimmed}`,
        );
      }
      if (!sequence && /(^|[^-=<>.])->(?!>)/.test(code)) {
        fail(
          `${doc}:${i + 1}`,
          `bare \`->\` is not an edge outside a sequence diagram: ${trimmed}`,
        );
      }
    }
  }
  if (blocks === 0)
    fail("contract", "no mermaid blocks found; this check examined nothing");
  if (VERBOSE) note(`mermaid: ${blocks} diagrams checked`);
}

function main() {
  const docs = allDocs();
  const surface = toolSurface();

  checkToolCount(surface);
  checkToolNames(docs);
  checkTranslations();
  checkLinks(docs);
  checkMermaid(docs);

  if (!surface.strong) {
    note(
      "tool checks used " +
        surface.source +
        " — build the desktop binary for the stronger answer (docs/PLUGINS.md has the command)",
    );
  }

  for (const n of notes) console.log(`note: ${n}`);

  if (errors.length > 0) {
    console.error(`\nDocumentation contract failed (${errors.length}):`);
    for (const e of errors) console.error(`- ${e}`);
    console.error(
      "\nEach of these is a stated fact that the code no longer supports. Fix the claim, not the check.",
    );
    process.exit(1);
  }

  console.log(
    `documentation contract: ${docs.length} documents, ${surface.names.length} tools (${surface.source}) — all stated facts match`,
  );
}

main();
