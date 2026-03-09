import type { VcsCapabilities, VcsRef } from "@t3tools/contracts";
import { Effect } from "effect";

import type { VcsCommandError } from "./Errors.ts";
import type { ExecuteVcsProcessResult } from "./Services/VcsProcess.ts";

export interface JjBookmarkRow {
  readonly name?: string;
  readonly remote?: string;
  readonly target?: ReadonlyArray<string | null>;
  readonly tracking_target?: ReadonlyArray<string | null>;
}

export interface JjLocalBookmark {
  readonly name?: string;
}

export interface JjRemoteInfo {
  readonly name: string;
  readonly url: string;
}

export interface VcsPullRequestInfo {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string | null;
}

export const DEFAULT_JJ_TIMEOUT_MS = 15_000;

export interface RunJj {
  (
    cwd: string,
    args: ReadonlyArray<string>,
    operation: string,
    allowNonZeroExit?: boolean,
  ): Effect.Effect<ExecuteVcsProcessResult, VcsCommandError>;
}

export function buildJjCapabilities(supportsCreatePullRequest: boolean): VcsCapabilities {
  return {
    supportsCommit: true,
    supportsPush: true,
    supportsPull: true,
    supportsCreatePullRequest,
    supportsCreateFeatureRef: true,
    supportsCreateWorkspace: true,
    supportsRemoveWorkspace: true,
    supportsCreateRef: false,
    supportsCheckoutRef: false,
    supportsInit: true,
    supportsCheckpointing: true,
  };
}

export function buildJjRevision(refName: string, refKind: VcsRef["kind"]) {
  if (refKind !== "remoteBookmark") {
    return refName;
  }
  const separatorIndex = refName.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === refName.length - 1) {
    return refName;
  }
  return refName;
}

export function parseJsonLines<T>(stdout: string): T[] {
  const parsed: T[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    parsed.push(JSON.parse(trimmed) as T);
  }
  return parsed;
}

export function parseJjRemoteList(stdout: string): ReadonlyArray<JjRemoteInfo> {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [name, ...urlParts] = line.split(/\s+/g);
      const url = urlParts.join(" ").trim();
      if (!name || !url) return [];
      return [{ name, url } satisfies JjRemoteInfo];
    });
}

export function isGitHubRemoteUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized.includes("github.com/") ||
    normalized.startsWith("git@github.com:") ||
    normalized.startsWith("ssh://git@github.com/")
  );
}

export function parsePullRequestList(raw: unknown): VcsPullRequestInfo[] {
  if (!Array.isArray(raw)) return [];

  const parsed: VcsPullRequestInfo[] = [];
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

function countOutputLines(stdout: string): number {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function sortUniqueNames(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(names)].toSorted((left, right) => left.localeCompare(right));
}

export function countJjRevset(runJj: RunJj, cwd: string, revset: string, operation: string) {
  return runJj(
    cwd,
    ["log", "-r", revset, "--no-graph", "-T", 'commit_id.short(8) ++ "\\n"'],
    operation,
  ).pipe(Effect.map((result) => countOutputLines(result.stdout)));
}

export function readCurrentJjBaseBookmarks(runJj: RunJj, cwd: string, operation: string) {
  return runJj(
    cwd,
    ["log", "-r", "heads(::@ & bookmarks())", "--no-graph", "-T", 'json(local_bookmarks) ++ "\\n"'],
    operation,
  ).pipe(
    Effect.map((result) =>
      sortUniqueNames(
        parseJsonLines<Array<JjLocalBookmark>>(result.stdout)
          .flatMap((row) => row)
          .map((bookmark) => bookmark.name?.trim() ?? "")
          .filter((bookmarkName) => bookmarkName.length > 0),
      ),
    ),
  );
}

export function listJjBookmarks(runJj: RunJj, cwd: string, operation: string) {
  return runJj(
    cwd,
    ["bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"'],
    operation,
  ).pipe(Effect.map((result) => parseJsonLines<JjBookmarkRow>(result.stdout)));
}

export function listJjRemotes(runJj: RunJj, cwd: string, operation: string) {
  return runJj(cwd, ["git", "remote", "list"], operation, true).pipe(
    Effect.map((result) => (result.code === 0 ? parseJjRemoteList(result.stdout) : [])),
  );
}

export function resolveJjPushRemote(
  runJj: RunJj,
  cwd: string,
  operations: {
    readonly config: string;
    readonly remotes: string;
  },
) {
  return Effect.gen(function* () {
    const [configResult, remotes] = yield* Effect.all(
      [
        runJj(cwd, ["config", "get", "git.push"], operations.config, true),
        listJjRemotes(runJj, cwd, operations.remotes),
      ],
      { concurrency: "unbounded" },
    );
    const configuredRemote = configResult.code === 0 ? configResult.stdout.trim() : "";
    if (configuredRemote.length > 0) {
      return remotes.find((remote) => remote.name === configuredRemote) ?? null;
    }
    if (remotes.length === 1) {
      return remotes[0] ?? null;
    }
    return remotes.find((remote) => remote.name === "origin") ?? null;
  });
}

export function readNearestAncestorRemoteBookmarkNames(
  runJj: RunJj,
  input: {
    readonly cwd: string;
    readonly revision: string;
    readonly remoteName: string;
    readonly operation: string;
  },
) {
  return runJj(
    input.cwd,
    [
      "log",
      "-r",
      `heads(::(${input.revision}) & remote_bookmarks(remote=${input.remoteName}))`,
      "--no-graph",
      "-T",
      'json(remote_bookmarks) ++ "\\n"',
    ],
    input.operation,
  ).pipe(
    Effect.map((result) =>
      sortUniqueNames(
        parseJsonLines<Array<JjBookmarkRow>>(result.stdout)
          .flatMap((row) => row)
          .filter((row) => row.remote === input.remoteName)
          .map((row) => row.name?.trim() ?? "")
          .filter((name) => name.length > 0),
      ),
    ),
  );
}
