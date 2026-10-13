---
name: release
description: Release pi-context-decisions to npm. Use when asked to cut a major, minor, or patch release, bump and publish a version, or verify a release. Releases are tag-driven through GitHub Actions trusted publishing.
---

# Release

Never release without explicit user authorization for this specific release. Preparing, validating or dry-running is fine; bumping, tagging, pushing a tag, or `npm publish` is not.

## Release model

- Workflow: `.github/workflows/release.yml`, triggered by pushing a semver tag such as `v0.1.1` (prereleases `v1.0.0-rc.1` also match).
- The job checks that the tag equals `package.json` version and that the tagged commit is on `origin/main`, then runs `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm pack --dry-run --ignore-scripts`, and `npm publish --access public --tag <latest|next>` through npm trusted publishing (GitHub OIDC). **No `NPM_TOKEN`; do not add one.**
- Changelog/GitHub Release workflow: `.github/workflows/changelog.yml`, independently triggered by the same version tags. It creates/updates the tag's GitHub Release, preserves handwritten highlights outside generated markers, and regenerates `CHANGELOG.md` on the default branch from all version tags plus merged PRs (including bots/unlabelled PRs). Stable notes compare against the previous stable ancestor, not an RC; major/minor/patch sections nest, with prereleases separate. The publisher rereads the tag's Release before merging highlights and recovers concurrent creation safely. Stable Releases use GitHub's `make_latest: legacy` selection from server-side history, never a forced `true` based on stale local tags; prereleases use `false`. Do not edit the generated changelog by hand.
- Changelog permissions are `contents: write` and `pull-requests: read` using `github.token`; no added secret. The npm workflow remains read-only for contents and uses OIDC. Default-branch protections must permit the changelog file update; failures are explicit, never force-pushed. Changelog runs use optimistic SHA retries with fresh tags, not global concurrency cancellation that could drop pending tag releases.
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
5. Independently verify the **Publish changelog** tag run (npm success does not imply notes success):
   ```sh
   gh run list --workflow changelog.yml --event push --json databaseId,headBranch,status,url
   gh run watch <changelog-run-id> --exit-status
   gh release view "$TAG" --json url,body,isPrerelease
   git pull --ff-only origin main      # pick up the workflow's changelog commit
   ```
   Choose the run whose `headBranch` equals `$TAG`; report the changelog run and Release URL, and verify `CHANGELOG.md` contains the tag. The changelog can succeed even if npm fails; that does not confirm npm publication.

## Changelog backfill and repair

Once the workflow is on the default branch, an explicitly authorized **Actions → Publish changelog → Run workflow** run with an existing semver tag creates/repairs that tag's GitHub Release and the cumulative changelog. Leave the tag empty to rebuild only `CHANGELOG.md` from all existing tags without creating a release (useful for the already published `v0.2.0`). This never bumps versions, creates tags, or publishes npm. The initial manually published `0.1.0` has no tag, so it is not invented as a tagged changelog entry.

An authenticated local `GITHUB_REPOSITORY=championswimmer/pi-context-decisions npm run changelog` preview requires full fetched tag history and `gh` access: it calls GitHub and writes CHANGELOG.md locally, but does not mutate remote Releases or branches. Do not run it without network authorization; do not use `--publish` locally without explicit recovery authorization. Keep handwritten summaries in GitHub Releases, outside the generated marker block.

## Failure handling

If changelog generation fails, inspect its run with `gh run view <changelog-run-id> --log-failed`; report whether the Release was created before the file update failed. Fix access/branch-protection or generation failures and re-run the existing tag run or the manual repair workflow with authorization. Do not re-publish npm, move a tag, or add a token to repair notes.

Quote the failing command and stderr, state what already happened (for example "tag pushed but workflow failed"), and give exact recovery steps before acting. If the publish step reports an authorization or "staged only" error, check the trusted publisher's allowed actions and its 2-day expiry before retrying.
