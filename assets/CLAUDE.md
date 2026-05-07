# Claude Instructions

Use GitNexus as the primary map before broad edits.

Before broad exploration:

1. Run `pnpm gitnexus:status`.
2. If needed, run `pnpm gitnexus:analyze`.
3. Use `docs/GITNEXUS_MAP.md` as the repository ownership map before editing.

This scope is non-source; prioritize referenced source scopes for behavior and ownership decisions.

## Repo Map

- Canonical map: `../docs/GITNEXUS_MAP.md`
- Use this to verify ownership before any cross-scope change.

## Graphify Trigger

- For knowledge-graph mapping requests, trigger `/graphify` before any edit planning.
