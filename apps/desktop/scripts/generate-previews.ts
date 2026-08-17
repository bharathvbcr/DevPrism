/**
 * Generate example projects for all LaTeX templates.
 *
 * Usage:  pnpm --filter @devprism/desktop generate-previews
 *
 * Requires the `tectonic` CLI (`brew install tectonic`). Tectonic is the app's
 * default engine (`compile_with_tectonic_subprocess` in src-tauri/src/latex.rs),
 * so compiling with it here is what makes this generator a real gate: a template
 * that only builds under pdfLaTeX would ship green from a pdfLaTeX generator and
 * then fail for every user. That is how "cv-modern" shipped broken — it loaded
 * `fontawesome5`, fine under pdfLaTeX's Type1 fonts but a SIGABRT under
 * Tectonic's XeTeX, dying before it could emit a single diagnostic.
 *
 * Known deviation from the app: the app injects `glyphtounicode.tex` and
 * `devprism-xetex-compat.tex` stubs into the build dir (latex.rs) so pdfTeX-only
 * primitives degrade to no-ops. This generator does not, which makes it strictly
 * *stricter* than the app — it can never green-light a template that breaks for
 * users, but a template relying on those stubs will be reported as a failure here.
 *
 * Output: public/examples/{template-id}/main.tex, main.pdf, references.bib (if applicable)
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import template registry (pure data, no DOM dependencies)
const registryPath = path.resolve(__dirname, "../src/lib/template-registry.ts");

// Since this is a .ts file with exports, we rely on tsx to handle it
async function loadTemplates() {
  const mod = await import(registryPath);
  return mod.getAllTemplates() as Array<{
    id: string;
    name: string;
    mainFileName: string;
    content: string;
    hasBibliography: boolean;
  }>;
}

const EXAMPLES_DIR = path.resolve(__dirname, "../public/examples");
// Matches ENGINE_TIMEOUT in src-tauri/src/latex.rs. A cold Tectonic run also has
// to fetch the bundle and build the format cache, which 30s does not cover.
const COMPILE_TIMEOUT = 180_000;

// `--print` streams the TeX log to stderr. Some classes (acmart, verified) write
// no .log file at all even under --keep-logs, so the file is not a reliable source
// of either diagnostics or the page count; the stream always is.
const MAX_ENGINE_OUTPUT = 64 * 1024 * 1024;

type CompileResult =
  | { ok: true; pages: number | null; overfull: number }
  | { ok: false; reason: string; engineAbort: boolean };

/**
 * Page count from the engine's own "Output written on ... (N pages, ...)" line,
 * or null if it never said. A template that compiles clean but emits an empty
 * document is still broken, and file size alone does not show that.
 */
function parsePages(engineOutput: string): number | null {
  // Tectonic reruns TeX, so take the last report.
  const all = [
    ...engineOutput.matchAll(/Output written on .*?\((\d+) pages?,/g),
  ];
  return all.length > 0 ? Number(all[all.length - 1][1]) : null;
}

/**
 * Overfull boxes are how a template silently overflows its margins — text running
 * off the page edge, or a header clipping its own content. Not fatal, so this is
 * reported as a count rather than a failure, but it is the only warning class that
 * reliably corresponds to something visibly wrong in the rendered page.
 */
function overfullCount(engineOutput: string): number {
  return (engineOutput.match(/^warning: .*Overfull \\hbox/gm) ?? []).length;
}

/** Tectonic prefixes its own diagnostics; the rest of --print output is log noise. */
function errorLines(engineOutput: string): string {
  return engineOutput
    .split("\n")
    .filter((line) => line.startsWith("error:"))
    .slice(0, 3)
    .join(" | ");
}

/**
 * Compile `texPath` in place with Tectonic, the engine the app itself uses.
 * Tectonic resolves cross-references over its own multi-pass loop, so unlike
 * pdfLaTeX this needs a single invocation.
 */
function compile(texPath: string, tmpDir: string): CompileResult {
  const run = spawnSync(
    "tectonic",
    ["-X", "compile", "--print", "--keep-logs", "--outdir", tmpDir, texPath],
    {
      cwd: tmpDir,
      timeout: COMPILE_TIMEOUT,
      encoding: "utf-8",
      maxBuffer: MAX_ENGINE_OUTPUT,
    },
  );

  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code;
    // Our own kill, so the silence below would be ours rather than the engine's.
    const reason =
      code === "ETIMEDOUT"
        ? `timed out after ${COMPILE_TIMEOUT / 1000}s`
        : `could not run tectonic: ${run.error.message}`;
    return { ok: false, reason, engineAbort: false };
  }

  if (run.status === 0)
    return {
      ok: true,
      pages: parsePages(output),
      overfull: overfullCount(output),
    };

  const errors = errorLines(output);
  // A SIGABRT (exit 134 through a shell) is a definite engine abort. Otherwise the
  // tell is silence: a LaTeX error always prints an `error:` line, so a non-zero
  // exit with none means the engine died before it could diagnose anything.
  const engineAbort =
    run.signal === "SIGABRT" || run.status === 134 || errors.length === 0;
  const where =
    run.status !== null
      ? `exit ${run.status}`
      : `signal ${run.signal ?? "unknown"}`;

  return {
    ok: false,
    reason: errors ? `${where}: ${errors}` : where,
    engineAbort,
  };
}

/** Fail the whole run up front rather than reporting the same miss 13 times. */
function requireTectonic() {
  try {
    execFileSync("tectonic", ["--version"], { stdio: "pipe" });
  } catch {
    console.error(
      "tectonic not found on PATH (or not runnable). Install it with `brew install tectonic`.",
    );
    console.error(
      "It is the engine the desktop app compiles with, so previews must be built with it too.",
    );
    process.exit(1);
  }
}

async function main() {
  console.log("Generating example projects...\n");

  requireTectonic();

  const templates = await loadTemplates();
  let successCount = 0;
  let failCount = 0;

  for (const template of templates) {
    process.stdout.write(`  ${template.id}... `);

    const exampleDir = path.join(EXAMPLES_DIR, template.id);
    fs.mkdirSync(exampleDir, { recursive: true });

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `prism-preview-${template.id}-`),
    );

    try {
      // Write .tex file (inject \null for blank templates to force a page)
      let content = template.content;
      if (template.id === "blank") {
        content = content.replace(
          "\\begin{document}",
          "\\begin{document}\n\\null",
        );
      }
      const texPath = path.join(tmpDir, template.mainFileName);
      fs.writeFileSync(texPath, content, "utf-8");

      // Write stub .bib if template uses bibliography
      if (template.hasBibliography) {
        fs.writeFileSync(
          path.join(tmpDir, "references.bib"),
          "% empty bibliography\n",
          "utf-8",
        );
      }

      const result = compile(texPath, tmpDir);
      if (!result.ok) {
        console.log(`FAIL: ${result.reason}`);
        if (result.engineAbort) {
          console.log(
            "        engine abort (died without diagnostics) — a package aborted XeTeX",
          );
          console.log(
            "        at load time, e.g. fontawesome5, fine under pdfLaTeX but not Tectonic.",
          );
        }
        failCount++;
        continue;
      }
      const pages = result.pages;
      if (pages === 0) {
        console.log("FAIL: compiled but produced an empty document (0 pages)");
        failCount++;
        continue;
      }

      // Copy source files to example folder
      fs.copyFileSync(texPath, path.join(exampleDir, template.mainFileName));
      if (template.hasBibliography) {
        fs.copyFileSync(
          path.join(tmpDir, "references.bib"),
          path.join(exampleDir, "references.bib"),
        );
      }

      // Copy compiled PDF to example folder
      const pdfName = template.mainFileName.replace(/\.tex$/, ".pdf");
      const pdfPath = path.join(tmpDir, pdfName);

      if (fs.existsSync(pdfPath)) {
        fs.copyFileSync(pdfPath, path.join(exampleDir, pdfName));
        const sizeKb = Math.round(
          fs.statSync(path.join(exampleDir, pdfName)).size / 1024,
        );
        const pageLabel =
          pages === null
            ? "page count unreported"
            : `${pages} page${pages === 1 ? "" : "s"}`;
        const overfull =
          result.overfull > 0 ? `, ${result.overfull} overfull` : "";
        console.log(`OK (${pageLabel}, ${sizeKb} KB${overfull})`);
        successCount++;
      } else {
        console.log("FAIL: exit 0 but no PDF written");
        failCount++;
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.slice(0, 120) : String(err);
      console.log(`FAIL: ${msg}`);
      failCount++;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(`\nDone: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    console.log(
      "A failure here is a template that will not compile for users either — the app runs",
    );
    console.log(
      "the same engine. Fix the template rather than accepting the CSS fallback thumbnail.",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
