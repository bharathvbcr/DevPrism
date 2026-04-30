# Release And Deployment

DevCouncil deploys through GitHub. Source pushes to `main` run lint. Version tags run the desktop packaging workflow.

## Repository

Remote:

```bash
git remote add origin https://github.com/bharathvbcr/DevPrism.git
git push -u origin main
```

## Local Verification

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm --filter @devcouncil/desktop test
pnpm --filter @devcouncil/desktop build
pnpm build
```

`pnpm build` creates unsigned local desktop bundles. GitHub release builds use `apps/desktop/src-tauri/tauri.release.conf.json`, which turns on Tauri updater artifacts only when release signing secrets are available.

## Release

Create and push a version tag:

```bash
git tag v0.0.3
git push origin v0.0.3
```

The `Build Desktop` workflow creates platform artifacts, uploads them to a draft GitHub Release, and generates `latest.json` for the Tauri updater.

## Required Release Secrets

Set these in GitHub repository secrets before publishing signed release builds:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_PASSWORD`
- `ZOTERO_CONSUMER_KEY`
- `ZOTERO_CONSUMER_SECRET`
