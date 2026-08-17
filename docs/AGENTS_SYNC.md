# AGENTS/CLAUDE Sync Checklist

Purpose:
- Keep every new scope directory aligned to the DevCouncil repo map before work starts there.

Pre-edit check:
1. Run `dev map --if-stale` at repo root before broad changes (or `dev map` after large refactors).
2. Ensure the target scope has both files when scope receives behavioral edits:
   - `AGENTS.md`
   - `CLAUDE.md`
3. If missing any file, create both.
4. Add these sections to each file:
   - `## Repo Map`
   - Reference `.devcouncil/repo_map.json` and/or `docs/DEV_MAP.md`
   - `## Must Use Map` with `dev graph` / MCP tooling pointers
5. Root `AGENTS.md` / `CLAUDE.md` are managed by `dev map` (marker-guarded). Do not hand-edit them; regenerate with `dev map`.
6. Cursor agents: keep `.cursor/rules/devcouncil-map.mdc` (alwaysApply) and `.cursor/mcp.json` (DevCouncil MCP). Refresh MCP with `dev integrate cursor --apply`.

Non-source scope rule:
- For assets/static-only directories, keep AGENTS/CLAUDE light and route edits to source instructions (`apps/desktop/...` or root) for ownership.

Quick enforcement command (run from repo root):

```powershell
$files = Get-ChildItem -Recurse -File -Path . | Where-Object { $_.Name -in @('AGENTS.md','CLAUDE.md') }
$missing = foreach ($f in $files) {
  $txt = Get-Content -Raw $f.FullName
  if ($txt -notmatch 'Managed by dev map|\.devcouncil/repo_map\.json|DEV_MAP\.md') { $f.FullName }
}
$files.Count
$missing.Count
$missing
```

Automatic enforcement:
- `pre-commit` now runs `pnpm agents:verify`.
- Use `pnpm agents:verify` anytime to validate staged files manually.

Pass criteria:
- No files appear in `$missing`.
- New scope has a DevCouncil map pointer before edits begin.

Additional audit:
- `pnpm agents:verify:all` checks all tracked `AGENTS.md` / `CLAUDE.md` files in the repo for compliance.
- Pre-commit runs:
  - `pnpm agents:verify` first
  - `pnpm exec biome check --staged --write --no-errors-on-unmatched` second

CI enforcement:
- `.github/workflows/lint.yml` runs `pnpm agents:verify:all` on `pull_request` and `push` to `main`.
