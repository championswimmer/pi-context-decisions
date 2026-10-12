---
name: release
description: Release pi-context-decisions to npm. Use when asked to cut a major, minor, or patch release, bump and publish a version, or verify a release. Releases are tag-driven through GitHub Actions trusted publishing.
---

# Release

Never release without explicit user authorization for this specific release. Preparing, validating or dry-running is fine; bumping, tagging, pushing a tag, or `npm publish` is not.

## Release model

- Workflow: `.github/workflows/release.yml`, triggered by pushing a semver tag such as `v0.1.1` (prereleases `v1.0.0-rc.1` also match).
- The job checks that the tag equals `package.json` version and that the tagged commit is on `origin/main`, then runs `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm pack --dry-run --ignore-scripts`, and `npm publish --access public --tag <latest|next>` through npm trusted publishing (GitHub OIDC). **No `NPM_TOKEN`; do not add one.**
- Dist-tag routing: a stable version (`0.2.0`) publishes to `latest`; a prerelease (`1.0.0-rc.1`, any version containing `-`) publishes to `next`. npm 11 refuses a prerelease on `latest` without `--tag`, so never expect a prerelease to move `latest`.
- Trusted publisher on npmjs.com: owner `championswimmer`, repository `pi-context-decisions`, workflow `release.yml`, no environment, and **"Allow npm publish" ticked**. Configurations created after Sep 3, 2026 default to `npm stage publish` only, so direct `npm publish` fails with an authorization error until that is enabled. Leave "npm dist-tag" off; the workflow does not use it.
- A new trusted publisher expires unless its first successful publish happens within 2 days; if it expired, delete and recreate it. Provenance is generated only for public repositories; a private repository publishes without it.
- The package ships TypeScript sources (`src/`); there is no build step.
- Do not run `npm publish` locally for normal releases; it would race the workflow. Never store npm tokens, use `--force`, or move/delete a published tag.

## First release, 0.1.0

`package.json` and the lockfile already say `0.1.0`, so do **not** run `npm version` for it. npm trusted publishers are configured on an existing package, so the user publishes `0.1.0` manually once from their own machine, then adds the trusted publisher (with "Allow npm publish"), and the first tag release (`v0.1.1`) must follow within the 2-day validation window. See the README "Publishing" section.

## Later releases (`major`, `minor`, `patch`)

Ask which bump if unspecified. Start from a clean `main` that matches `origin/main`; commit intended changes first without unrelated work.

1. Validate locally:
   ```sh
   git status --porcelain            # must be empty
   git fetch origin && git checkout main && git pull --ff-only origin main
   npm ci --ignore-scripts && npm run typecheck && npm test && npm pack --dry-run --ignore-scripts
   ```
2. Bump, commit and tag (updates `package.json` and `package-lock.json`):
   ```sh
   npm version <major|minor|patch> -m "chore: release v%s"
   VERSION=$(node -p "require('./package.json').version"); TAG="v$VERSION"
   git push --atomic origin main "$TAG"
   ```
3. Watch the tag-push run (retry until listed), choosing the run whose `headBranch` equals `$TAG`:
   ```sh
   gh run list --workflow release.yml --event push --json databaseId,headBranch,status,url
   gh run watch <run-id> --exit-status
   ```
   On failure use `gh run view <run-id> --log-failed`. Do not bump again or move the tag until the cause is known; a failed run before publish can be re-run.
4. Confirm publication, retrying briefly for registry propagation. Check the dist-tag the workflow used: `latest` for a stable version, `next` for a prerelease (and confirm `latest` did **not** move for a prerelease):
   ```sh
   npm view "pi-context-decisions@$VERSION" version --registry=https://registry.npmjs.org
   case "$VERSION" in *-*) DIST_TAG=next ;; *) DIST_TAG=latest ;; esac
   npm view pi-context-decisions "dist-tags.$DIST_TAG" --registry=https://registry.npmjs.org
   ```
   Report version, dist-tag, run URL and status. If you could not confirm, say publication is unconfirmed.

## Failure handling

Quote the failing command and stderr, state what already happened (for example "tag pushed but workflow failed"), and give exact recovery steps before acting. If the publish step reports an authorization or "staged only" error, check the trusted publisher's allowed actions and its 2-day expiry before retrying.
