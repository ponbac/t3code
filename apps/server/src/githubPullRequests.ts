import { Effect } from "effect";

import type { GitHubCliShape } from "./git/Services/GitHubCli.ts";

export interface GitHubRemote {
  name: string;
  url: string;
}

export interface GitHubPullRequestInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
}

export interface FindPreferredPullRequestForRemotesInput {
  cwd: string;
  headRefName: string;
  remotes: ReadonlyArray<GitHubRemote>;
  preferredRemoteName?: string | null;
  execute: GitHubCliShape["execute"];
}

interface GitHubPullRequestRecord extends GitHubPullRequestInfo {
  repoNameWithOwner: string;
}

export function parseGitHubRepoNameWithOwner(url: string): string | null {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return null;
  }

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    const owner = sshMatch[1]?.trim();
    const repo = sshMatch[2]?.trim();
    if (owner && repo) {
      return `${owner}/${repo}`;
    }
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const [owner, repo] = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
    if (!owner || !repo) {
      return null;
    }
    return `${owner.trim()}/${repo.trim()}`;
  } catch {
    return null;
  }
}

export function resolveGitHubRepoCandidates(input: {
  remotes: ReadonlyArray<GitHubRemote>;
  preferredRemoteName?: string | null;
}): string[] {
  const preferredRepoName = input.preferredRemoteName
    ? parseGitHubRepoNameWithOwner(
        input.remotes.find((remote) => remote.name === input.preferredRemoteName)?.url ?? "",
      )
    : null;
  const seen = new Set<string>();
  const output: string[] = [];

  if (preferredRepoName) {
    seen.add(preferredRepoName);
    output.push(preferredRepoName);
  }

  for (const remote of input.remotes) {
    const repoName = parseGitHubRepoNameWithOwner(remote.url);
    if (!repoName || seen.has(repoName)) {
      continue;
    }
    seen.add(repoName);
    output.push(repoName);
  }

  return output;
}

function parsePullRequestList(raw: unknown): GitHubPullRequestInfo[] {
  if (!Array.isArray(raw)) return [];

  const parsed: GitHubPullRequestInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const baseRefName = record.baseRefName;
    const headRefName = record.headRefName;
    const state = record.state;
    const mergedAt = record.mergedAt;
    const updatedAt = record.updatedAt;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0 ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string"
    ) {
      continue;
    }

    let normalizedState: "open" | "closed" | "merged";
    if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
      normalizedState = "merged";
    } else if (state === "CLOSED") {
      normalizedState = "closed";
    } else {
      normalizedState = "open";
    }

    parsed.push({
      number,
      title,
      url,
      baseRefName,
      headRefName,
      state: normalizedState,
      updatedAt: typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null,
    });
  }
  return parsed;
}

function comparePullRequests(
  left: GitHubPullRequestRecord,
  right: GitHubPullRequestRecord,
  preferredRepoOrder: ReadonlyMap<string, number>,
) {
  const leftOpenRank = left.state === "open" ? 0 : 1;
  const rightOpenRank = right.state === "open" ? 0 : 1;
  if (leftOpenRank !== rightOpenRank) {
    return leftOpenRank - rightOpenRank;
  }

  const leftRepoRank = preferredRepoOrder.get(left.repoNameWithOwner) ?? Number.MAX_SAFE_INTEGER;
  const rightRepoRank = preferredRepoOrder.get(right.repoNameWithOwner) ?? Number.MAX_SAFE_INTEGER;
  if (leftRepoRank !== rightRepoRank) {
    return leftRepoRank - rightRepoRank;
  }

  const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
  const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
  return rightUpdated - leftUpdated;
}

export function selectPreferredPullRequest(input: {
  pullRequests: ReadonlyArray<GitHubPullRequestRecord>;
  preferredRepoNames: ReadonlyArray<string>;
}): GitHubPullRequestInfo | null {
  if (input.pullRequests.length === 0) {
    return null;
  }

  const preferredRepoOrder = new Map(
    input.preferredRepoNames.map((repoName, index) => [repoName, index] as const),
  );
  return input.pullRequests.toSorted((left, right) =>
    comparePullRequests(left, right, preferredRepoOrder),
  )[0] ?? null;
}

export function findPreferredPullRequestAcrossRepos(input: {
  cwd: string;
  headRefName: string;
  repoNamesWithOwner: ReadonlyArray<string>;
  execute: GitHubCliShape["execute"];
}) {
  return Effect.gen(function* () {
    const repoNamesWithOwner =
      input.repoNamesWithOwner.length > 0 ? input.repoNamesWithOwner : [null];
    const candidates = yield* Effect.all(
      repoNamesWithOwner.map((repoNameWithOwner) =>
        input.execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            ...(repoNameWithOwner ? ["--repo", repoNameWithOwner] : []),
            "--head",
            input.headRefName,
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt",
          ],
        })
          .pipe(
            Effect.map((result) => {
              const stdout = result.stdout.trim();
              if (stdout.length === 0) {
                return [] as GitHubPullRequestInfo[];
              }
              try {
                return parsePullRequestList(JSON.parse(stdout) as unknown);
              } catch {
                return [] as GitHubPullRequestInfo[];
              }
            }),
            Effect.map((pullRequests) =>
              pullRequests.map((pullRequest) => ({
                ...pullRequest,
                repoNameWithOwner: repoNameWithOwner ?? "",
              })),
            ),
            Effect.catch(() => Effect.succeed([] as GitHubPullRequestRecord[])),
          ),
      ),
      { concurrency: "unbounded" },
    );

    return selectPreferredPullRequest({
      pullRequests: candidates.flat(),
      preferredRepoNames: input.repoNamesWithOwner,
    });
  });
}

export function findPreferredPullRequestForRemotes(
  input: FindPreferredPullRequestForRemotesInput,
) {
  return findPreferredPullRequestAcrossRepos({
    cwd: input.cwd,
    headRefName: input.headRefName,
    repoNamesWithOwner: resolveGitHubRepoCandidates({
      remotes: input.remotes,
      ...(input.preferredRemoteName !== undefined
        ? { preferredRemoteName: input.preferredRemoteName }
        : {}),
    }),
    execute: input.execute,
  });
}
