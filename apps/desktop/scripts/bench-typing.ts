/**
 * Manual benchmark: editor keystroke → store-commit path on a large
 * manuscript.
 *
 * Run with:  pnpm --filter @devprism/desktop bench:typing
 *
 * Reports, over simulated continuous typing:
 *   - wall-clock per-keystroke overhead of schedule() (the hot path)
 *   - store commits produced vs. what per-keystroke commits would have cost
 *
 * Counter output is deterministic; timings are indicative only (node, not the
 * webview) and exist to catch gross O(n²)-style regressions in the snapshot
 * stringification path.
 */
import { createDebouncedContentPush } from "../src/lib/editor/debounced-content-push";

function buildManuscript(targetBytes: number): string {
  const paragraph =
    "The observed interference pattern suggests a coherent superposition " +
    "of the eigenstates described in Equation~\\eqref{eq:hamiltonian}, " +
    "consistent with prior measurements $\\alpha = 0.03 \\pm 0.01$.\n\n";
  let doc = "\\documentclass{article}\n\\begin{document}\n";
  while (doc.length < targetBytes) {
    doc += `\\section{Results}\n${paragraph.repeat(12)}`;
  }
  return `${doc}\\end{document}`;
}

async function main() {
  const target = Number(process.argv[2] ?? 200_000);
  const manuscript = buildManuscript(target);
  const keystrokes = 500;

  console.log(
    `manuscript: ${(manuscript.length / 1024).toFixed(0)} KB, ${keystrokes} keystrokes @10ms`,
  );

  // ── Debounced path (what ships) ──
  let committed = 0;
  let sinkContent = manuscript;
  const push = createDebouncedContentPush(150, (_fileId, content) => {
    if (content === sinkContent) return;
    sinkContent = content;
    committed += 1;
  });

  let doc = manuscript;
  const startAll = performance.now();
  const perKeystroke: number[] = [];
  for (let i = 0; i < keystrokes; i++) {
    doc = `${doc}x`;
    const t0 = performance.now();
    push.schedule("main.tex", doc);
    perKeystroke.push(performance.now() - t0);
    await sleep(10);
  }
  push.flush();
  const totalMs = performance.now() - startAll;
  void totalMs;

  const sorted = [...perKeystroke].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p999 = sorted[Math.floor(sorted.length * 0.999)];

  console.log("debounced push:");
  console.log(`  store commits:        ${committed}`);
  console.log(`  schedule() p50:       ${p50.toFixed(4)} ms`);
  console.log(`  schedule() p99.9:     ${p999.toFixed(4)} ms`);
  console.log(`  final content landed: ${sinkContent === doc ? "yes" : "NO"}`);

  // ── Baseline: what per-keystroke commits would do ──
  let baselineCommits = 0;
  let baselineContent = manuscript;
  const baselineStart = performance.now();
  let baselineDoc = manuscript;
  for (let i = 0; i < keystrokes; i++) {
    baselineDoc = `${baselineDoc}x`;
    // The old code did this per keystroke: full map + generation bump.
    if (baselineDoc !== baselineContent) {
      baselineContent = baselineDoc;
      baselineCommits += 1;
    }
  }
  const baselineMs = performance.now() - baselineStart;
  console.log("per-keystroke baseline (pre-fix behavior):");
  console.log(
    `  store commits:        ${baselineCommits} (${(baselineCommits / committed).toFixed(0)}× more churn)`,
  );
  console.log(`  loop time:            ${baselineMs.toFixed(1)} ms`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main();
