# AGENTS/CLAUDE Sync Checklist

Purpose:
- Keep every new scope directory aligned to the repo map + graphify contract before work starts there.

Pre-edit check:
1. Run `gitnexus:status` at repo root before broad changes.
2. Ensure the target scope has both files when scope receives behavioral edits:
   - `AGENTS.md`
   - `CLAUDE.md`
3. If missing any file, create both.
4. Add these sections to each file:
   - `## Repo Map`
   - Reference `GITNEXUS_MAP.md`
   - `## Graphify Trigger`
   - Rule: `/graphify` for knowledge-graph mapping requests

Non-source scope rule:
- For assets/static-only directories, keep AGENTS/CLAUDE light and route edits to source instructions (`apps/desktop/...` or root) for ownership.

Quick enforcement command (run from `devprism-main`):

```powershell
$files = Get-ChildItem -Recurse -File -Path . | Where-Object { $_.Name -in @('AGENTS.md','CLAUDE.md') }
$missing = foreach ($f in $files) {
  $txt = Get-Content -Raw $f.FullName
  if ($txt -notmatch 'Repo Map|Graphify Trigger|/graphify') { $f.FullName }
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
- New scope has map pointer and graphify trigger before edits begin.

Additional audit:
- `pnpm agents:verify:all` checks all tracked `AGENTS.md` / `CLAUDE.md` files in the repo for compliance.
- Pre-commit runs:
  - `pnpm agents:verify` first
  - `pnpm exec biome check --staged --write --no-errors-on-unmatched` second

CI enforcement:
- `.github/workflows/lint.yml` runs `pnpm agents:verify:all` on `pull_request` and `push` to `main`.
