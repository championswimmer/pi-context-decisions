// Adapted from ../pi-subagent-manager: generated notes, Release highlights and SHA retries.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const start = "<!-- generated-release-notes:start -->";
const end = "<!-- generated-release-notes:end -->";

export interface VersionTag {
  tag: string;
  version: Version;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string };
}

export interface ReleaseNotes extends VersionTag {
  date: string;
  body: string;
}

// Keep release automation dependency-free: the package ships no runtime dependencies.
interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): Version | undefined {
  if (value.length > 256) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((id) => /^0\d+$/.test(id))) return undefined;
  return { major, minor, patch, prerelease };
}

function compareVersions(a: Version, b: Version): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric && left.length !== right.length)
      return left.length < right.length ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function versionTags(tags: string[]): VersionTag[] {
  return tags.flatMap((tag) => {
    const version = tag.startsWith("v") ? parseVersion(tag.slice(1)) : undefined;
    return version ? [{ tag, version }] : [];
  }).sort((a, b) => compareVersions(b.version, a.version));
}

// Stable releases compare to stable tags, so promoting an RC does not lose its PRs.
export function previousTag(
  current: VersionTag,
  tags: VersionTag[],
  isAncestor: (previous: string, current: string) => boolean,
): string | undefined {
  return tags.find(
    (candidate) =>
      compareVersions(candidate.version, current.version) < 0 &&
      (current.version.prerelease.length > 0 || candidate.version.prerelease.length === 0) &&
      isAncestor(candidate.tag, current.tag),
  )?.tag;
}

export function completePullRequests(
  body: string,
  pulls: PullRequest[],
  commits: Set<string>,
): string {
  const included = new Set(
    [...body.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\b/g)].map((match) =>
      Number(match[1]),
    ),
  );
  const missing = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha &&
      commits.has(pr.merge_commit_sha) &&
      !included.has(pr.number),
  );
  if (!missing.length) return body;
  const bullets = missing
    .sort((a, b) => a.number - b.number)
    .map((pr) => `* ${pr.title.replace(/[\r\n]+/g, " ")} by @${pr.user.login} in ${pr.html_url}`);
  return `${body.trim()}\n\n## Additional merged pull requests\n${bullets.join("\n")}`;
}

// Preserve handwritten highlights when re-running or backfilling an existing release.
export function releaseBody(existing: string, generated: string): string {
  const marker = existing.indexOf(start);
  const closing = existing.indexOf(end, marker);
  const manual = (
    marker < 0 || closing < 0
      ? existing
      : `${existing.slice(0, marker)}${existing.slice(closing + end.length)}`
  ).trim();
  return `${manual ? `${manual}\n\n` : ""}${start}\n${generated.trim()}\n${end}\n`;
}

function nestedBody(body: string, level: number): string {
  let fence: string | undefined;
  return body
    .replaceAll(start, "")
    .replaceAll(end, "")
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(`{3,}|~{3,})/);
      if (match) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
        return line;
      }
      if (fence) return line;
      return line.replace(
        /^(#{1,6}) /,
        (_, hashes: string) =>
          "#".repeat(Math.min(6, level + Math.max(1, hashes.length - 1))) + " ",
      );
    })
    .join("\n");
}

export function renderChangelog(releases: ReleaseNotes[], repository: string): string {
  const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  const sections = [
    "# Changelog",
    "Generated from version tags and merged GitHub pull requests. Do not edit this file directly; add handwritten highlights to the GitHub Release instead.",
  ];
  const entry = (release: ReleaseNotes, level: number, kind: string) => {
    sections.push(
      `${"#".repeat(level)} [${release.tag}](https://github.com/${repository}/releases/tag/${release.tag}) — ${kind} (${release.date})`,
      nestedBody(release.body, level),
    );
  };
  const stable = sorted.filter((release) => !release.version.prerelease.length);
  for (const major of [...new Set(stable.map((release) => release.version.major))]) {
    const group = stable.filter((release) => release.version.major === major);
    const initial = group.find((release) => !release.version.minor && !release.version.patch);
    if (initial) entry(initial, 2, "Major release");
    else sections.push(`## ${major}.x${major === 0 ? " — Pre-1.0 releases" : ""}`);
    for (const minor of [...new Set(group.map((release) => release.version.minor))]) {
      const children = group.filter(
        (release) => release.version.minor === minor && release !== initial,
      );
      if (!children.length) continue;
      const base = children.find((release) => !release.version.patch);
      if (base) entry(base, 3, "Minor release");
      else sections.push(`### ${major}.${minor}.x`);
      for (const patch of children.filter((release) => release !== base))
        entry(patch, 4, "Patch release");
    }
  }
  const prereleases = sorted.filter((release) => release.version.prerelease.length);
  if (prereleases.length) {
    sections.push("## Prereleases");
    for (const release of prereleases) entry(release, 3, "Prerelease");
  }
  return `${sections.join("\n\n")}\n`;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function api<T>(method: string, path: string, data?: object): T {
  return JSON.parse(
    execFileSync("gh", ["api", "--method", method, path, ...(data ? ["--input", "-"] : [])], {
      encoding: "utf8",
      stdio: "pipe", // Expected 404/create-race errors are handled by the caller.
      input: data ? JSON.stringify(data) : undefined,
    }),
  ) as T;
}

function pages<T>(path: string): T[] {
  return (
    JSON.parse(
      execFileSync("gh", ["api", "--paginate", "--slurp", path], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as T[][]
  ).flat();
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  body: string | null;
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Set GITHUB_REPOSITORY=owner/repo and authenticate gh first.");
  }
  const publish = process.argv.includes("--publish");
  const tag = process.env.CHANGELOG_TAG || undefined;
  if (tag && versionTags([tag]).length !== 1) throw new Error(`Invalid version tag: ${tag}`);
  const path = `repos/${repository}`;
  const repo = api<{ default_branch: string }>("GET", path);

  const generate = (): Array<ReleaseNotes & { generated: string }> => {
    const tags = versionTags(git("tag", "--list").split("\n"));
    if (!tags.length) throw new Error("No version tags found. Fetch the full tag history first.");
    if (tag && !tags.some((candidate) => candidate.tag === tag))
      throw new Error(`Tag not found: ${tag}`);
    const pulls = pages<PullRequest>(`${path}/pulls?state=closed&per_page=100`);
    const existing = pages<GitHubRelease>(`${path}/releases?per_page=100`);
    return tags.map((current) => {
      const previous = previousTag(current, tags, (a, b) => {
        try {
          git("merge-base", "--is-ancestor", a, b);
          return true;
        } catch {
          return false;
        }
      });
      const generated = api<{ body: string }>("POST", `${path}/releases/generate-notes`, {
        tag_name: current.tag,
        ...(previous ? { previous_tag_name: previous } : {}),
      });
      const commits = new Set(
        git("rev-list", previous ? `${previous}..${current.tag}` : current.tag).split("\n"),
      );
      const body = completePullRequests(generated.body, pulls, commits);
      return {
        ...current,
        date: git("show", "-s", "--format=%cs", `${current.tag}^{commit}`),
        generated: body,
        body: releaseBody(
          existing.find((release) => release.tag_name === current.tag)?.body ?? "",
          body,
        ),
      };
    });
  };

  let releases = generate();
  let content = renderChangelog(releases, repository);
  writeFileSync("CHANGELOG.md", content);
  if (!publish) return;

  if (tag) {
    // Verify the remote tag: the Releases API otherwise silently creates missing tags.
    api("GET", `${path}/git/ref/tags/${encodeURIComponent(tag)}`);
    const current = releases.find((release) => release.tag === tag)!;
    const readRelease = (): GitHubRelease | undefined => {
      try {
        return api("GET", `${path}/releases/tags/${encodeURIComponent(tag)}`);
      } catch (error) {
        if (!/HTTP 404\b/.test(String(error))) throw error;
        return undefined;
      }
    };
    const data = {
      draft: false,
      prerelease: current.version.prerelease.length > 0,
      // Let GitHub select latest from its server-side release history and semantic
      // versions. A stale tag checkout must never force an older release to latest.
      make_latest: current.version.prerelease.length ? "false" : "legacy",
    };
    const update = (existing: GitHubRelease): void => {
      api("PATCH", `${path}/releases/${existing.id}`, {
        ...data,
        // Never send highlights from generate()'s potentially stale snapshot.
        body: releaseBody(existing.body ?? "", current.generated),
      });
    };
    const existing = readRelease();
    if (existing) update(existing);
    else {
      try {
        api("POST", `${path}/releases`, {
          ...data,
          tag_name: tag,
          name: tag,
          body: releaseBody("", current.generated),
        });
      } catch (error) {
        if (!/HTTP 422\b/.test(String(error))) throw error;
        // Another run may have created this release after the GET returned 404.
        // Only recover when it now exists; preserve its highlights on the PATCH.
        const raced = readRelease();
        if (!raced) throw error;
        update(raced);
      }
    }
    console.log(`Published GitHub Release ${tag}`);
  }

  // Optimistic file updates avoid force pushes, preserve other files, and let concurrent
  // tag runs all publish releases (global Actions concurrency would drop pending tags).
  for (let attempt = 0; attempt < 3; attempt++) {
    let file: { sha: string; content: string } | undefined;
    try {
      file = api(
        "GET",
        `${path}/contents/CHANGELOG.md?ref=${encodeURIComponent(repo.default_branch)}`,
      );
    } catch (error) {
      if (!String(error).includes("HTTP 404")) throw error;
    }
    // Read the file SHA BEFORE refreshing tags/generating, preventing a stale run from
    // overwriting a newer changelog. Retry the entire snapshot on an update conflict.
    git("fetch", "origin", "--tags");
    releases = generate();
    content = renderChangelog(releases, repository);
    writeFileSync("CHANGELOG.md", content);
    if (file && Buffer.from(file.content, "base64").toString("utf8") === content) {
      console.log("CHANGELOG.md is already up to date");
      return;
    }
    try {
      api("PUT", `${path}/contents/CHANGELOG.md`, {
        message: "docs: update changelog from version tags [skip ci]",
        content: Buffer.from(content).toString("base64"),
        branch: repo.default_branch,
        ...(file ? { sha: file.sha } : {}),
      });
      console.log(`Updated CHANGELOG.md on ${repo.default_branch}`);
      return;
    } catch (error) {
      if (attempt === 2 || !/HTTP (409|422)/.test(String(error))) throw error;
      console.warn("Concurrent changelog update; refreshing tags and retrying");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
