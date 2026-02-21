import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir, rm, writeFile, readFile, access, cp, realpath } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const MAX_CONCURRENT = 3;
const COMPILE_TIMEOUT_MS = 30000;

let activeCompilations = 0;

// Track last build dir per project for synctex inverse search
const lastBuildDirs = new Map<string, { workDir: string; mainFileName: string }>();

function sanitizePath(workDir: string, filePath: string): string | null {
  if (filePath.includes("..")) return null;
  const normalized = resolve(workDir, filePath);
  if (!normalized.startsWith(`${workDir}/`) && normalized !== workDir) {
    return null;
  }
  return normalized;
}

interface Resource {
  path?: string;
  content?: string;
  file?: string;
  main?: boolean;
}

interface CompileRequest {
  compiler?: string;
  resources?: Resource[];
  projectDir?: string;
  mainFile?: string;
}

interface CompileError {
  error: string;
  details?: string;
  log_files?: Record<string, string>;
}

const runWithTimeout = (
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> => {
  return new Promise((resolve) => {
    const [command, ...args] = cmd;
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, COMPILE_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, timedOut, stdout, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, timedOut: false, stdout, stderr: stderr || err.message });
    });
  });
};

export const compileRoutes = new Hono();

compileRoutes.use("/builds/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

compileRoutes.get("/", (c) => {
  return c.json({ status: "ok", service: "claude-prism-sidecar" });
});

compileRoutes.post("/builds/sync", async (c) => {
  if (activeCompilations >= MAX_CONCURRENT) {
    return c.json(
      { error: "Server busy, try again later" } satisfies CompileError,
      503,
    );
  }

  const body = await c.req.json<CompileRequest>();
  const { compiler = "pdflatex", resources, projectDir, mainFile } = body;

  // Mode 1: Project directory mode (desktop app)
  if (projectDir) {
    return handleProjectDirCompile(c, compiler, projectDir, mainFile || "document.tex");
  }

  // Mode 2: Resource upload mode (legacy/web compatibility)
  if (!resources || resources.length === 0) {
    return c.json(
      { error: "No resources or projectDir provided" } satisfies CompileError,
      400,
    );
  }

  return handleResourceCompile(c, compiler, resources);
});

async function handleProjectDirCompile(
  c: any,
  compiler: string,
  projectDir: string,
  mainFile: string,
) {
  // Use realpath to resolve symlinks (macOS: /var → /private/var)
  // so the stored workDir matches paths returned by synctex
  const rawWorkDir = join(tmpdir(), `latex-${randomUUID()}`);
  await mkdir(rawWorkDir, { recursive: true });
  const workDir = await realpath(rawWorkDir);

  // Clean up previous build dir for this project
  const prevBuild = lastBuildDirs.get(projectDir);
  if (prevBuild) {
    await rm(prevBuild.workDir, { recursive: true, force: true }).catch(() => {});
    lastBuildDirs.delete(projectDir);
  }

  // pdflatex outputs to CWD using basename (e.g. "chapters/doc.tex" → "doc.pdf")
  const mainFileName = basename(mainFile).replace(/\.tex$/, "");

  activeCompilations++;
  try {
    // Copy project to temp dir to avoid polluting with aux files
    await cp(projectDir, workDir, { recursive: true });

    const compilerCmd =
      compiler === "xelatex"
        ? "xelatex"
        : compiler === "lualatex"
          ? "lualatex"
          : "pdflatex";

    // Check for .bib files
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(workDir, { recursive: true });
    const hasBib = files.some((f: string) => f.endsWith(".bib"));

    const latexCmd = [compilerCmd, "-interaction=nonstopmode", "-synctex=1", mainFile];
    let lastResult = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };

    if (hasBib) {
      lastResult = await runWithTimeout(latexCmd, workDir);
      if (lastResult.timedOut) {
        return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
      }

      const auxPath = join(workDir, `${mainFileName}.aux`);
      const auxExists = await access(auxPath).then(() => true).catch(() => false);
      if (auxExists) {
        lastResult = await runWithTimeout(["bibtex", mainFileName], workDir);
        if (lastResult.timedOut) {
          return c.json({ error: "BibTeX timed out" } satisfies CompileError, 500);
        }
      }

      for (let i = 0; i < 2; i++) {
        lastResult = await runWithTimeout(latexCmd, workDir);
        if (lastResult.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    } else {
      lastResult = await runWithTimeout(latexCmd, workDir);
      if (lastResult.timedOut) {
        return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
      }
    }

    let pdfPath = join(workDir, `${mainFileName}.pdf`);
    const logPath = join(workDir, `${mainFileName}.log`);

    let logContent = "";
    try {
      logContent = await readFile(logPath, "utf-8");
    } catch {}

    // If "No pages of output", retry with \null injected to force an empty page
    const pdfExists = await access(pdfPath).then(() => true).catch(() => false);
    if (!pdfExists && logContent.includes("No pages of output")) {
      const retryCmd = [
        compilerCmd,
        "-interaction=nonstopmode",
        `-jobname=${mainFileName}`,
        `\\AtEndDocument{\\null}\\input{${mainFile}}`,
      ];
      lastResult = await runWithTimeout(retryCmd, workDir);
      try {
        logContent = await readFile(logPath, "utf-8");
      } catch {}
    }

    try {
      const pdfBuffer = await readFile(pdfPath);
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename=${mainFileName}.pdf`,
        },
      });
    } catch {
      const details = extractErrorLines(logContent)
        || lastResult.stderr
        || lastResult.stdout.slice(-500)
        || "No PDF produced. Check that pdflatex is installed.";
      return c.json(
        {
          error: "Compilation failed",
          details,
        } satisfies CompileError,
        500,
      );
    }
  } finally {
    activeCompilations--;
    // Keep workDir alive for synctex inverse search
    lastBuildDirs.set(projectDir, { workDir, mainFileName });
  }
}

function extractErrorLines(log: string): string {
  if (!log) return "";
  const lines = log.split("\n");

  // Check for "No pages of output" (comment-only or empty document body)
  if (lines.some((l) => l.includes("No pages of output"))) {
    return "No pages of output. Add visible content to the document body.";
  }

  const errorLines = lines.filter(
    (l) => l.startsWith("!") || l.includes("Error:") || l.includes("error:"),
  );
  return errorLines.slice(0, 10).join("\n") || log.slice(-500);
}

async function handleResourceCompile(
  c: any,
  compiler: string,
  resources: Resource[],
) {
  const mainResource = resources.find((r) => r.main) || resources[0];
  const mainPath = mainResource.path || "main.tex";
  const mainFileName = mainPath.replace(/\.tex$/, "");

  const workDir = join(tmpdir(), `latex-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  activeCompilations++;
  try {
    const hasBib = resources.some((r) => r.path?.endsWith(".bib"));

    for (const resource of resources) {
      const filePath =
        resource.path || (resource.main ? "main.tex" : `file-${randomUUID()}`);
      const fullPath = sanitizePath(workDir, filePath);

      if (!fullPath) {
        return c.json({ error: "Invalid path" } satisfies CompileError, 400);
      }

      const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (parentDir && parentDir !== workDir) {
        await mkdir(parentDir, { recursive: true });
      }

      if (resource.file) {
        const buffer = Buffer.from(resource.file, "base64");
        await writeFile(fullPath, buffer);
      } else if (resource.content) {
        await writeFile(fullPath, resource.content, "utf-8");
      }
    }

    const compilerCmd =
      compiler === "xelatex"
        ? "xelatex"
        : compiler === "lualatex"
          ? "lualatex"
          : "pdflatex";

    const latexCmd = [compilerCmd, "-interaction=nonstopmode", mainPath];

    if (hasBib) {
      let result = await runWithTimeout(latexCmd, workDir);
      if (result.timedOut) {
        return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
      }

      const auxPath = join(workDir, `${mainFileName}.aux`);
      const auxExists = await access(auxPath).then(() => true).catch(() => false);
      if (auxExists) {
        result = await runWithTimeout(["bibtex", mainFileName], workDir);
        if (result.timedOut) {
          return c.json({ error: "BibTeX timed out" } satisfies CompileError, 500);
        }
      }

      for (let i = 0; i < 2; i++) {
        result = await runWithTimeout(latexCmd, workDir);
        if (result.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    } else {
      for (let i = 0; i < 2; i++) {
        const result = await runWithTimeout(latexCmd, workDir);
        if (result.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    }

    const pdfPath = join(workDir, `${mainFileName}.pdf`);
    const logPath = join(workDir, `${mainFileName}.log`);

    let logContent = "";
    try {
      logContent = await readFile(logPath, "utf-8");
    } catch {}

    try {
      const pdfBuffer = await readFile(pdfPath);
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename=${mainFileName}.pdf`,
        },
      });
    } catch {
      return c.json(
        {
          error: "Compilation failed",
          details: extractErrorLines(logContent),
          log_files: { "__main_document__.log": logContent },
        } satisfies CompileError,
        500,
      );
    }
  } finally {
    activeCompilations--;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// SyncTeX inverse search: PDF coordinates → source file + line
// Reference: Overleaf CLSI SynctexOutputParser + CompileManager
compileRoutes.post("/synctex/edit", async (c) => {
  const { projectDir, page, x, y } = await c.req.json<{
    projectDir: string;
    page: number;
    x: number;
    y: number;
  }>();

  const build = lastBuildDirs.get(projectDir);
  if (!build) {
    return c.json({ error: "No build found for this project" }, 404);
  }

  // Verify that synctex data was generated
  const synctexGz = join(build.workDir, `${build.mainFileName}.synctex.gz`);
  const synctexPlain = join(build.workDir, `${build.mainFileName}.synctex`);
  const hasSynctex = await access(synctexGz).then(() => true).catch(() =>
    access(synctexPlain).then(() => true).catch(() => false)
  );
  if (!hasSynctex) {
    return c.json({ error: "No synctex data found. Recompile with synctex enabled." }, 404);
  }

  const pdfFile = `${build.mainFileName}.pdf`;
  const result = await runWithTimeout(
    ["synctex", "edit", "-o", `${page}:${x}:${y}:${pdfFile}`],
    build.workDir,
  );

  if (result.exitCode !== 0) {
    console.error("[synctex] edit failed:", result.stderr, result.stdout);
    return c.json({ error: "synctex failed", details: result.stderr || result.stdout }, 500);
  }

  // Parse synctex output (Overleaf-style):
  //   SyncTeX result begin
  //   Output:main.pdf
  //   Input:./main.tex
  //   Line:42
  //   Column:0
  //   ...
  //   SyncTeX result end
  const outputLines = result.stdout.split("\n");
  let file = "";
  let line = 0;
  let column = 0;

  for (const l of outputLines) {
    const trimmed = l.trim();
    if (trimmed.startsWith("Input:")) file = trimmed.slice("Input:".length);
    else if (trimmed.startsWith("Line:")) line = parseInt(trimmed.slice("Line:".length), 10);
    else if (trimmed.startsWith("Column:")) column = Math.max(0, parseInt(trimmed.slice("Column:".length), 10));
  }

  if (!file || line === 0) {
    console.error("[synctex] could not parse result:", result.stdout);
    return c.json({ error: "Could not resolve source location", raw: result.stdout }, 404);
  }

  // Normalize file path to relative path within project:
  // synctex may return "./main.tex", absolute "/tmp/.../main.tex", or just "main.tex"
  let relativeFile = file;
  if (relativeFile.startsWith(build.workDir + "/")) {
    relativeFile = relativeFile.slice(build.workDir.length + 1);
  }
  if (relativeFile.startsWith("./")) {
    relativeFile = relativeFile.slice(2);
  }

  return c.json({ file: relativeFile, line, column });
});
