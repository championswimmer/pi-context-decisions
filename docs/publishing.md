[README](../README.md) · [Documentation](README.md)

# Publishing

Releases are tag-driven through GitHub Actions. Bumping a version, tagging, pushing a release tag or publishing requires explicit release authorization. A documentation commit is not a release.

The initial manual `0.1.0` bootstrap is historical; use the tag-driven procedure for subsequent releases. Do not run `npm publish` locally for normal releases.

On npmjs.com open the package, **Settings, Trusted publishing, Add trusted publisher, GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `championswimmer` |
| Repository | `pi-context-decisions` |
| Workflow filename | `release.yml` |
| Environment | leave empty |
| Allowed actions | tick **Allow npm publish** (see below); leave *npm dist-tag* off |

Per the [npm trusted publishing docs](https://docs.npmjs.com/trusted-publishers/):

- **Allow npm publish is required.** Trusted publisher configurations created after Sep 3, 2026 default to `npm stage publish` only. `release.yml` publishes directly with `npm publish`, so without that tick the release fails. (Alternatively, switch the workflow to `npm stage publish` and approve each release by hand with 2FA.)
- **The first successful publish must happen within 2 days.** A new configuration that is not validated by a publish in that window expires and cannot be edited; delete it and create a new one. Create or recreate the trusted publisher when you are ready for an authorized tag release.
- `repository.url` in `package.json` must exactly match the GitHub repository (it does), the runner must be GitHub-hosted, and npm CLI must be >= 11.5.1 (the workflow installs it).
- Trusted publishing works for private repositories, but **provenance is only generated for public repositories**. Private repositories publish without provenance; public repositories can receive it. No `--provenance` flag is needed or used.

Later releases: bump, commit and tag with `npm version <major|minor|patch> -m "chore: release v%s"`, then `git push --atomic origin main vX.Y.Z`. [`.github/workflows/release.yml`](../.github/workflows/release.yml) verifies the tag matches `package.json`, that the commit is on `main`, runs the tests and publishes with OIDC; no `NPM_TOKEN`. Stable versions go to the `latest` dist-tag; prerelease versions (for example `v1.0.0-rc.1`) go to `next`, because npm refuses to publish a prerelease to `latest` without `--tag`. The project-local `release` skill (`.agents/skills/release`) describes the procedure.

### Automatic changelog and GitHub Releases

[`.github/workflows/changelog.yml`](../.github/workflows/changelog.yml) runs independently on the same version tags. It creates or updates the tag's GitHub Release and commits a cumulative [CHANGELOG.md](../CHANGELOG.md) to the default branch. Notes use GitHub's generated release notes plus any missing merged PRs from the actual ancestor-tag commit range, including bots and unlabelled PRs. Stable releases compare against the previous stable ancestor (not their RC); major, minor and patch entries are nested, with prereleases separate. Handwritten highlights in GitHub Releases survive regeneration; the publisher rereads the tag's Release before merging highlights and recovers concurrent creation without dropping manual notes. Stable releases delegate GitHub's latest selection with `make_latest: legacy` (using server-side release history rather than a stale local tag snapshot); prereleases use `false`. Do not edit CHANGELOG.md directly.

The workflow uses the repository's automatic `github.token` with `contents: write` and `pull-requests: read`; no new secret or npm permission is needed. npm publishing keeps its existing read-only contents/OIDC permissions. Repository rules must allow this workflow token to update CHANGELOG.md on the default branch; protected-branch refusals fail visibly rather than bypassing protection. Concurrent updates retry with fresh file SHAs and tags, without force pushes or cancelling pending tag runs. Notes remain available even if npm publishing fails; their success does not confirm npm publication.

After merging the automation, **Actions → Publish changelog → Run workflow** can repair an existing tag's GitHub Release, or use an empty tag to rebuild the changelog from all existing version tags without creating a release. It never bumps a version, pushes a tag, or publishes to npm. A local authenticated preview (`GITHUB_REPOSITORY=championswimmer/pi-context-decisions npm run changelog`, with full local tag history and `gh` authentication) calls GitHub and writes CHANGELOG.md locally but makes no remote mutations; `--publish` is reserved for the authorized workflow/recovery procedure.

See [AGENTS.md](../AGENTS.md) and `.agents/plans/` for pending contributor handoffs; completed and superseded plans have been removed. [Archived research and live-validation evidence](../.agents/research/README.md) retain historical observations, not pending implementation tasks. `../pi-skill-picker-jev` was a pattern reference, not a dependency. The implemented static snapshot and fail-closed defaults above supersede earlier dynamic/fail-open recommendations.
