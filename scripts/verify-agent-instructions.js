#!/usr/bin/env node
const { execSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const REQUIRED_RULES = [
  { name: "Repo Map section", pattern: /## Repo Map/i },
  { name: "Graphify section", pattern: /## Graphify Trigger/i },
  { name: "Map reference", pattern: /GITNEXUS_MAP\.md/i },
  { name: "Graphify trigger command", pattern: /\/graphify/i },
];

function getAllInstructionFiles() {
  const output = execSync("git ls-files -- AGENTS.md CLAUDE.md", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return output;
}

function getStagedPaths() {
  const output = execSync(
    "git diff --cached --name-status -z --diff-filter=ACMRT",
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trimEnd();

  if (!output) {
    return [];
  }

  const tokens = output.split("\0").filter(Boolean);
  const items = [];
  let i = 0;

  while (i < tokens.length) {
    const status = tokens[i++];

    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (newPath) {
        items.push({ status, path: newPath, oldPath });
      }
      continue;
    }

    const filePath = tokens[i++];
    if (filePath) {
      items.push({ status, path: filePath });
    }
  }

  return items;
}

function isInstructionFile(filePath) {
  const base = path.basename(filePath);
  return base === "AGENTS.md" || base === "CLAUDE.md";
}

function stagedContent(filePath) {
  const result = spawnSync("git", ["show", `:${filePath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout ?? "";
}

function fileContent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function hasAllRequiredSections(content) {
  return REQUIRED_RULES.every((rule) => rule.pattern.test(content));
}

function hasTrackedPath(filePath) {
  const result = spawnSync("git", ["cat-file", "-e", `HEAD:${filePath}`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function stagedHasInstruction(dir, file) {
  const filePath = dir === "." ? `${file}` : `${dir}/${file}`;
  const content = stagedContent(filePath);
  if (content === null) {
    return false;
  }
  return hasAllRequiredSections(content);
}

function reportError(messages, pathValue, reason, lines) {
  const detail = lines.length ? ` (${lines.join(", ")})` : "";
  messages.push(`${pathValue} ${reason}${detail}`);
}

function main() {
  const runAll = process.argv.includes("--all");

  if (runAll) {
    const allFiles = getAllInstructionFiles();
    const errors = [];

    for (const filePath of allFiles) {
      const content = fileContent(filePath);
      if (content === null) {
        continue;
      }

      const missing = REQUIRED_RULES.filter(
        (rule) => !rule.pattern.test(content),
      ).map((rule) => rule.name);
      if (missing.length > 0) {
        errors.push(
          `${filePath} missing required fields (${missing.join(", ")})`,
        );
      }
    }

    if (errors.length > 0) {
      console.error("GitNexus instruction audit failed:");
      for (const err of errors) {
        console.error(`- ${err}`);
      }
      console.error("See docs/AGENTS_SYNC.md for the required checklist.");
      process.exit(1);
    }

    return;
  }

  const staged = getStagedPaths();
  const errors = [];

  const touchedInstructionFiles = staged.filter((item) =>
    isInstructionFile(item.path),
  );
  const addedOrCopied = staged.filter(
    (item) => item.status.startsWith("A") || item.status.startsWith("C"),
  );
  const seenDirs = new Set();

  for (const item of touchedInstructionFiles) {
    const content = stagedContent(item.path);
    if (content === null) {
      continue;
    }

    const missing = REQUIRED_RULES.filter(
      (rule) => !rule.pattern.test(content),
    ).map((rule) => rule.name);
    if (missing.length > 0) {
      reportError(
        errors,
        item.path,
        "missing required sections",
        missing.map((r) => r.source),
      );
    }
  }

  for (const item of addedOrCopied) {
    const dir = path.dirname(item.path).replace(/\\/g, "/");
    if (dir === "." || seenDirs.has(dir)) {
      continue;
    }
    seenDirs.add(dir);

    if (hasTrackedPath(dir)) {
      continue;
    }

    const hasAgents = stagedHasInstruction(dir, "AGENTS.md");
    const hasClaude = stagedHasInstruction(dir, "CLAUDE.md");
    if (!hasAgents || !hasClaude) {
      const missing = [];
      if (!hasAgents) missing.push("AGENTS.md");
      if (!hasClaude) missing.push("CLAUDE.md");
      reportError(
        errors,
        dir,
        "new folder is missing required instruction files",
        missing,
      );
    }
  }

  if (errors.length > 0) {
    console.error("GitNexus instruction check failed:");
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    console.error("See docs/AGENTS_SYNC.md for the required checklist.");
    process.exit(1);
  }
}

main();
