import { realpathSync } from "node:fs";
import path from "node:path";

import { Cache, Data, Duration, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { GitCommandError } from "../Errors.ts";
import {
  EMPTY_EXCLUDED_TOP_LEVEL_NAMES,
  isPathInExcludedTopLevelDirectory,
} from "../repoPathFilters.ts";
import { GitService } from "../Services/GitService.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { RepoContextResolver } from "../Services/RepoContext.ts";
import { runProcess } from "../../processRunner.ts";

const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

interface JjCurrentBookmarkState {
  currentBookmarks: string[];
  resolvedBranch: string | null;
  ambiguousBookmarks: string[];
}

interface ExecuteGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted((a, b) => b.length - a.length);
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseRemoteRefWithRemoteNames(
  branchName: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; localBranch: string } | null {
  const trimmedBranchName = branchName.trim();
  if (trimmedBranchName.length === 0) return null;

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!trimmedBranchName.startsWith(remotePrefix)) {
      continue;
    }
    const localBranch = trimmedBranchName.slice(remotePrefix.length).trim();
    if (localBranch.length === 0) {
      return null;
    }
    return {
      remoteRef: trimmedBranchName,
      remoteName,
      localBranch,
    };
  }

  return null;
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function commandLabel(args: readonly string[]): string {
  if (args[0] === "jj") {
    return args.join(" ");
  }
  return `git ${args.join(" ")}`;
}

function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

function parseWhitespaceDelimitedNames(stdout: string): string[] {
  return stdout
    .split(/\s+/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function buildCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  return trimmedBody.length > 0 ? `${subject}\n\n${trimmedBody}` : subject;
}

function parseJjDiffStat(stdout: string): {
  files: Array<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
} {
  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let insertions = 0;
  let deletions = 0;

  for (const rawLine of stdout.split(/\r?\n/g)) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.includes("files changed")) {
      continue;
    }

    const match = /^(.*?)\s+\|\s+\d+\s+([+-]+)$/.exec(line);
    if (!match) {
      continue;
    }

    const [, rawPath = "", glyphs = ""] = match;
    const path = rawPath.trim();
    if (path.length === 0) {
      continue;
    }

    const fileInsertions = glyphs.split("").filter((glyph) => glyph === "+").length;
    const fileDeletions = glyphs.split("").filter((glyph) => glyph === "-").length;
    insertions += fileInsertions;
    deletions += fileDeletions;
    files.push({
      path,
      insertions: fileInsertions,
      deletions: fileDeletions,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    insertions,
    deletions,
  };
}

function parseJjBookmarkList(stdout: string): Array<{ name: string; remote: string | null }> {
  const bookmarks: Array<{ name: string; remote: string | null }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [nameRaw = "", remoteRaw = ""] = trimmed.split("\t");
    const name = nameRaw.trim();
    if (name.length === 0) {
      continue;
    }
    const remote = remoteRaw.trim();
    bookmarks.push({
      name,
      remote: remote.length > 0 ? remote : null,
    });
  }
  return bookmarks;
}

function toJjBookmarkRef(remoteName: string, branch: string): string {
  return `${branch}@${remoteName}`;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const makeGitCore = Effect.gen(function* () {
  const git = yield* GitService;
  const repoContextResolver = yield* RepoContextResolver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
    git
      .execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      .pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          if (stderr.length > 0) {
            return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
          }
          if (options.fallbackErrorMessage) {
            return Effect.fail(
              createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
            );
          }
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
            ),
          );
        }),
      );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const executeJj = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: {
      timeoutMs?: number | undefined;
      allowNonZeroExit?: boolean | undefined;
      fallbackErrorMessage?: string | undefined;
      stdin?: string | undefined;
    } = {},
  ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
    Effect.tryPromise({
      try: () =>
        runProcess("jj", args, {
          cwd,
          timeoutMs: options.timeoutMs ?? 30_000,
          allowNonZeroExit: true,
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        }),
      catch: (cause) =>
        createGitCommandError(
          operation,
          cwd,
          [`jj`, ...args],
          cause instanceof Error ? cause.message : "Failed to run jj command.",
          cause,
        ),
    }).pipe(
      Effect.flatMap((result) => {
        const code = result.code ?? 1;
        if (options.allowNonZeroExit || code === 0) {
          return Effect.succeed({
            code,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }

        const stderr = result.stderr.trim();
        return Effect.fail(
          createGitCommandError(
            operation,
            cwd,
            [`jj`, ...args],
            stderr || options.fallbackErrorMessage || `jj ${args.join(" ")} failed`,
          ),
        );
      }),
    );

  const runJj = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeJj(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runJjStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeJj(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const readRawConfigValue = (
    cwd: string,
    key: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const writeRawConfigValue = (
    cwd: string,
    key: string,
    value: string,
  ): Effect.Effect<void, GitCommandError> =>
    runGit("GitCore.writeConfigValue", cwd, ["config", key, value]);

  const unsetRawConfigValue = (cwd: string, key: string): Effect.Effect<void, GitCommandError> =>
    runGit("GitCore.unsetConfigValue", cwd, ["config", "--unset-all", key], true);

  const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const resolveAvailableBranchName = (
    cwd: string,
    desiredBranch: string,
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
      if (!isDesiredTaken) {
        return desiredBranch;
      }

      for (let suffix = 1; suffix <= 100; suffix += 1) {
        const candidate = `${desiredBranch}-${suffix}`;
        const isCandidateTaken = yield* branchExists(cwd, candidate);
        if (!isCandidateTaken) {
          return candidate;
        }
      }

      return yield* createGitCommandError(
        "GitCore.renameBranch",
        cwd,
        ["branch", "-m", "--", desiredBranch],
        `Could not find an available branch name for '${desiredBranch}'.`,
      );
    });

  const resolveCurrentUpstream = (
    cwd: string,
  ): Effect.Effect<
    { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
    GitCommandError
  > =>
    Effect.gen(function* () {
      const upstreamRef = yield* runGitStdout(
        "GitCore.resolveCurrentUpstream",
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
        return null;
      }

      const separatorIndex = upstreamRef.indexOf("/");
      if (separatorIndex <= 0) {
        return null;
      }
      const remoteName = upstreamRef.slice(0, separatorIndex);
      const upstreamBranch = upstreamRef.slice(separatorIndex + 1);
      if (remoteName.length === 0 || upstreamBranch.length === 0) {
        return null;
      }

      return {
        upstreamRef,
        remoteName,
        upstreamBranch,
      };
    });

  const fetchUpstreamRef = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    return runGit(
      "GitCore.fetchUpstreamRef",
      cwd,
      ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      true,
    );
  };

  const fetchUpstreamRefForStatus = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    return executeGit(
      "GitCore.fetchUpstreamRefForStatus",
      cwd,
      ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      {
        allowNonZeroExit: true,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const statusUpstreamRefreshCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: (cacheKey: StatusUpstreamRefreshCacheKey) =>
      Effect.gen(function* () {
        yield* fetchUpstreamRefForStatus(cacheKey.cwd, {
          upstreamRef: cacheKey.upstreamRef,
          remoteName: cacheKey.remoteName,
          upstreamBranch: cacheKey.upstreamBranch,
        });
        return true as const;
      }),
    // Keep successful refreshes warm; drop failures immediately so next request can retry.
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_UPSTREAM_REFRESH_INTERVAL : Duration.zero),
  });

  const refreshStatusUpstreamIfStale = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* Cache.get(
        statusUpstreamRefreshCache,
        new StatusUpstreamRefreshCacheKey({
          cwd,
          upstreamRef: upstream.upstreamRef,
          remoteName: upstream.remoteName,
          upstreamBranch: upstream.upstreamBranch,
        }),
      );
    });

  const refreshCheckedOutBranchUpstream = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* fetchUpstreamRef(cwd, upstream);
    });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitCore.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.code !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    branch: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitCore.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map((stdout) => parseRemoteNames(stdout).toReversed()),
    );

  const resolvePrimaryRemoteName = (cwd: string): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      if (yield* originRemoteExists(cwd)) {
        return "origin";
      }
      const remotes = yield* listRemoteNames(cwd);
      const [firstRemote] = remotes;
      if (firstRemote) {
        return firstRemote;
      }
      return yield* createGitCommandError(
        "GitCore.resolvePrimaryRemoteName",
        cwd,
        ["remote"],
        "No git remote is configured for this repository.",
      );
    });

  const resolvePushRemoteName = (
    cwd: string,
    branch: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const branchPushRemote = yield* runGitStdout(
        "GitCore.resolvePushRemoteName.branchPushRemote",
        cwd,
        ["config", "--get", `branch.${branch}.pushRemote`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      if (branchPushRemote.length > 0) {
        return branchPushRemote;
      }

      const pushDefaultRemote = yield* runGitStdout(
        "GitCore.resolvePushRemoteName.remotePushDefault",
        cwd,
        ["config", "--get", "remote.pushDefault"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      if (pushDefaultRemote.length > 0) {
        return pushDefaultRemote;
      }

      return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
    });

  const readLocalBookmarksAtRevision = (
    cwd: string,
    revision: string,
    operation: string,
  ): Effect.Effect<string[], GitCommandError> =>
    runJjStdout(
      operation,
      cwd,
      ["log", "-r", revision, "--no-graph", "-T", 'local_bookmarks ++ "\\n"'],
      true,
    ).pipe(
      Effect.map((stdout) =>
        parseWhitespaceDelimitedNames(stdout).toSorted((a, b) => a.localeCompare(b)),
      ),
    );

  const resolveManagedWorkspaceBranchForCwd = (
    cwd: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    readManagedWorkspaceConfigEntries(cwd).pipe(
      Effect.map((entries) => {
        const canonicalCwd = canonicalizeExistingPath(cwd);
        for (const entry of entries) {
          if (canonicalizeExistingPath(entry.path) === canonicalCwd) {
            return entry.branch;
          }
        }
        return null;
      }),
    );

  const pathExists = (candidatePath: string): Effect.Effect<boolean> =>
    fileSystem.exists(candidatePath).pipe(Effect.catch(() => Effect.succeed(false)));

  const resolveJjCurrentBookmarkState = (
    cwd: string,
  ): Effect.Effect<JjCurrentBookmarkState, GitCommandError> =>
    Effect.gen(function* () {
      const currentBookmarksAtHead = yield* readLocalBookmarksAtRevision(
        cwd,
        "@",
        "GitCore.JJ.currentBookmarks.at",
      );
      if (currentBookmarksAtHead.length > 0) {
        return {
          currentBookmarks: currentBookmarksAtHead,
          resolvedBranch: currentBookmarksAtHead.length === 1 ? currentBookmarksAtHead[0]! : null,
          ambiguousBookmarks: currentBookmarksAtHead.length > 1 ? currentBookmarksAtHead : [],
        };
      }

      const managedWorkspaceBranch = yield* resolveManagedWorkspaceBranchForCwd(cwd);
      if (managedWorkspaceBranch) {
        return {
          currentBookmarks: [managedWorkspaceBranch],
          resolvedBranch: managedWorkspaceBranch,
          ambiguousBookmarks: [],
        };
      }

      const parentBookmarks = yield* readLocalBookmarksAtRevision(
        cwd,
        "@-",
        "GitCore.JJ.currentBookmarks.parent",
      );
      if (parentBookmarks.length === 1) {
        return {
          currentBookmarks: parentBookmarks,
          resolvedBranch: parentBookmarks[0]!,
          ambiguousBookmarks: [],
        };
      }

      return {
        currentBookmarks: [],
        resolvedBranch: null,
        ambiguousBookmarks: parentBookmarks.length > 1 ? parentBookmarks : [],
      };
    });

  const resolveTargetBookmark = (
    cwd: string,
    branchHint: string | null | undefined,
    operation: string,
    commandArgs: readonly string[],
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const explicit = branchHint?.trim() ?? "";
      if (explicit.length > 0) {
        return explicit;
      }

      const bookmarkState = yield* resolveJjCurrentBookmarkState(cwd);
      if (bookmarkState.resolvedBranch) {
        return bookmarkState.resolvedBranch;
      }

      return yield* createGitCommandError(
        operation,
        cwd,
        commandArgs,
        bookmarkState.currentBookmarks.length > 1 || bookmarkState.ambiguousBookmarks.length > 1
          ? "Cannot determine the current JJ bookmark because multiple bookmarks are associated with this workspace. Use a dedicated workspace or select an explicit branch first."
          : "Cannot determine the current JJ bookmark for this workspace.",
      );
    });

  const readManagedWorkspaceConfigEntries = (
    cwd: string,
  ): Effect.Effect<Array<{ branch: string; path: string }>, GitCommandError> =>
    runGitStdout(
      "GitCore.JJ.readManagedWorkspaceConfigEntries",
      cwd,
      ["config", "--get-regexp", "^branch\\..*\\.t3-workspace-path$"],
      true,
    ).pipe(
      Effect.map((stdout) => {
        const entries: Array<{ branch: string; path: string }> = [];
        for (const line of stdout.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const separatorIndex = trimmed.indexOf(" ");
          if (separatorIndex <= 0) {
            continue;
          }
          const key = trimmed.slice(0, separatorIndex);
          const value = trimmed.slice(separatorIndex + 1).trim();
          if (
            value.length === 0 ||
            !key.startsWith("branch.") ||
            !key.endsWith(".t3-workspace-path")
          ) {
            continue;
          }
          const branch = key.slice("branch.".length, -".t3-workspace-path".length);
          if (branch.length === 0) {
            continue;
          }
          entries.push({ branch, path: value });
        }
        return entries;
      }),
    );

  const cleanupStaleManagedWorkspacePaths = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const entries = yield* readManagedWorkspaceConfigEntries(cwd);
      for (const entry of entries) {
        const exists = yield* pathExists(entry.path);
        if (!exists) {
          yield* unsetRawConfigValue(cwd, `branch.${entry.branch}.t3-workspace-path`);
        }
      }
    });

  const readManagedWorkspacePath = (
    cwd: string,
    branch: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const recordedPath = yield* readRawConfigValue(cwd, `branch.${branch}.t3-workspace-path`);
      if (!recordedPath) {
        return null;
      }
      const exists = yield* pathExists(recordedPath);
      if (exists) {
        return recordedPath;
      }
      yield* unsetRawConfigValue(cwd, `branch.${branch}.t3-workspace-path`);
      return null;
    });

  const setManagedWorkspacePath = (
    cwd: string,
    branch: string,
    workspacePath: string,
  ): Effect.Effect<void, GitCommandError> =>
    cleanupStaleManagedWorkspacePaths(cwd).pipe(
      Effect.flatMap(() =>
        writeRawConfigValue(cwd, `branch.${branch}.t3-workspace-path`, workspacePath),
      ),
    );

  const unsetManagedWorkspacePath = (
    cwd: string,
    branch: string,
  ): Effect.Effect<void, GitCommandError> =>
    unsetRawConfigValue(cwd, `branch.${branch}.t3-workspace-path`);

  const resolveConfiguredBookmarkUpstream = (
    cwd: string,
    branch: string,
  ): Effect.Effect<
    { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
    GitCommandError
  > =>
    Effect.gen(function* () {
      const remoteName = yield* readRawConfigValue(cwd, `branch.${branch}.remote`);
      const mergeRef = yield* readRawConfigValue(cwd, `branch.${branch}.merge`);
      if (!remoteName || !mergeRef?.startsWith("refs/heads/")) {
        return null;
      }
      const upstreamBranch = mergeRef.slice("refs/heads/".length).trim();
      if (upstreamBranch.length === 0) {
        return null;
      }
      return {
        upstreamRef: `${remoteName}/${upstreamBranch}`,
        remoteName,
        upstreamBranch,
      };
    });

  const setBookmarkUpstreamConfig = (
    cwd: string,
    branch: string,
    remoteName: string,
    remoteBranch: string,
  ): Effect.Effect<void, GitCommandError> =>
    Effect.all(
      [
        writeRawConfigValue(cwd, `branch.${branch}.remote`, remoteName),
        writeRawConfigValue(cwd, `branch.${branch}.merge`, `refs/heads/${remoteBranch}`),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.asVoid);

  const resolveBookmarkGitSha = (
    cwd: string,
    branch: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitCore.JJ.resolveBookmarkGitSha",
      cwd,
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.map((result) => {
        if (result.code !== 0) {
          return null;
        }
        const sha = result.stdout.trim();
        return sha.length > 0 ? sha : null;
      }),
    );

  const parseRemoteRefForJj = (
    cwd: string,
    branchName: string,
  ): Effect.Effect<
    { remoteName: string; remoteBranch: string; localBranch: string } | null,
    GitCommandError
  > =>
    listRemoteNames(cwd).pipe(
      Effect.map((remoteNames) => {
        const parsed = parseRemoteRefWithRemoteNames(branchName, remoteNames);
        if (!parsed) {
          return null;
        }
        return {
          remoteName: parsed.remoteName,
          remoteBranch: parsed.localBranch,
          localBranch: parsed.localBranch,
        };
      }),
    );

  const ensureLocalBookmarkFromRef = (
    cwd: string,
    branchName: string,
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const parsedRemoteRef = yield* parseRemoteRefForJj(cwd, branchName);
      if (!parsedRemoteRef) {
        return branchName;
      }

      yield* runJj("GitCore.JJ.ensureLocalBookmarkFromRef.fetch", cwd, [
        "git",
        "fetch",
        "--remote",
        parsedRemoteRef.remoteName,
        "--branch",
        parsedRemoteRef.localBranch,
      ]);
      yield* runJj("GitCore.JJ.ensureLocalBookmarkFromRef.materialize", cwd, [
        "bookmark",
        "set",
        parsedRemoteRef.localBranch,
        "--revision",
        toJjBookmarkRef(parsedRemoteRef.remoteName, parsedRemoteRef.localBranch),
      ]);
      yield* setBookmarkUpstreamConfig(
        cwd,
        parsedRemoteRef.localBranch,
        parsedRemoteRef.remoteName,
        parsedRemoteRef.localBranch,
      );
      return parsedRemoteRef.localBranch;
    });

  const ensureRemote: GitCoreShape["ensureRemote"] = (input) =>
    Effect.gen(function* () {
      const preferredName = sanitizeRemoteName(input.preferredName);
      const normalizedTargetUrl = normalizeRemoteUrl(input.url);
      const remoteFetchUrls = yield* runGitStdout(
        "GitCore.ensureRemote.listRemoteUrls",
        input.cwd,
        ["remote", "-v"],
      ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

      for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
        if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
          return remoteName;
        }
      }

      let remoteName = preferredName;
      let suffix = 1;
      while (remoteFetchUrls.has(remoteName)) {
        remoteName = `${preferredName}-${suffix}`;
        suffix += 1;
      }

      yield* runGit("GitCore.ensureRemote.add", input.cwd, [
        "remote",
        "add",
        remoteName,
        input.url,
      ]);
      return remoteName;
    });

  const resolveBaseBranchForNoUpstream = (
    cwd: string,
    branch: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const configuredBaseBranch = yield* runGitStdout(
        "GitCore.resolveBaseBranchForNoUpstream.config",
        cwd,
        ["config", "--get", `branch.${branch}.gh-merge-base`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const defaultBranch =
        primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
      const candidates = [
        configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
        defaultBranch,
        ...DEFAULT_BASE_BRANCH_CANDIDATES,
      ];

      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        const remotePrefix =
          primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
        const normalizedCandidate = candidate.startsWith("origin/")
          ? candidate.slice("origin/".length)
          : remotePrefix && candidate.startsWith(remotePrefix)
            ? candidate.slice(remotePrefix.length)
            : candidate;
        if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
          continue;
        }

        if (yield* branchExists(cwd, normalizedCandidate)) {
          return normalizedCandidate;
        }

        if (
          primaryRemoteName &&
          (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
        ) {
          return `${primaryRemoteName}/${normalizedCandidate}`;
        }
      }

      return null;
    });

  const computeAheadCountAgainstBase = (
    cwd: string,
    branch: string,
  ): Effect.Effect<number, GitCommandError> =>
    Effect.gen(function* () {
      const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
      if (!baseBranch) {
        return 0;
      }

      const result = yield* executeGit(
        "GitCore.computeAheadCountAgainstBase",
        cwd,
        ["rev-list", "--count", `${baseBranch}..HEAD`],
        { allowNonZeroExit: true },
      );
      if (result.code !== 0) {
        return 0;
      }

      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    });

  const readBranchRecency = (cwd: string): Effect.Effect<Map<string, number>, GitCommandError> =>
    Effect.gen(function* () {
      const branchRecency = yield* executeGit(
        "GitCore.readBranchRecency",
        cwd,
        [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
          "refs/remotes",
        ],
        {
          timeoutMs: 15_000,
          allowNonZeroExit: true,
        },
      );

      const branchLastCommit = new Map<string, number>();
      if (branchRecency.code !== 0) {
        return branchLastCommit;
      }

      for (const line of branchRecency.stdout.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const [name, lastCommitRaw] = line.split("\t");
        if (!name) {
          continue;
        }
        const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
        branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
      }

      return branchLastCommit;
    });

  const statusDetails: GitCoreShape["statusDetails"] = (cwd) =>
    Effect.gen(function* () {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(Effect.ignoreCause({ log: true }));
      const excludedTopLevelNames = yield* repoContextResolver.resolve(cwd).pipe(
        Effect.map((repoContext) =>
          Option.isSome(repoContext)
            ? repoContext.value.excludedTopLevelNames
            : EMPTY_EXCLUDED_TOP_LEVEL_NAMES,
        ),
        Effect.catch(() => Effect.succeed(EMPTY_EXCLUDED_TOP_LEVEL_NAMES)),
      );

      const [statusStdout, unstagedNumstatStdout, stagedNumstatStdout] = yield* Effect.all(
        [
          runGitStdout("GitCore.statusDetails.status", cwd, [
            "status",
            "--porcelain=2",
            "--branch",
          ]),
          runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      let branch: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let hasWorkingTreeChanges = false;
      const changedFilesWithoutNumstat = new Set<string>();

      for (const line of statusStdout.split(/\r?\n/g)) {
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          branch = value.startsWith("(") ? null : value;
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }
        if (line.trim().length > 0 && !line.startsWith("#")) {
          const pathValue = parsePorcelainPath(line);
          if (pathValue && isPathInExcludedTopLevelDirectory(pathValue, excludedTopLevelNames)) {
            continue;
          }
          hasWorkingTreeChanges = true;
          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
        }
      }

      if (!upstreamRef && branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(0)),
        );
        behindCount = 0;
      }

      const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
      const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const entry of [...stagedEntries, ...unstagedEntries]) {
        if (isPathInExcludedTopLevelDirectory(entry.path, excludedTopLevelNames)) {
          continue;
        }
        const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }

      let insertions = 0;
      let deletions = 0;
      const files = Array.from(fileStatMap.entries())
        .map(([filePath, stat]) => {
          insertions += stat.insertions;
          deletions += stat.deletions;
          return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        branch,
        upstreamRef,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions,
          deletions,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
      };
    });

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd, filePaths) =>
    Effect.gen(function* () {
      if (filePaths && filePaths.length > 0) {
        yield* runGit("GitCore.prepareCommitContext.reset", cwd, ["reset"]).pipe(
          Effect.catch(() => Effect.void),
        );
        yield* runGit("GitCore.prepareCommitContext.addSelected", cwd, [
          "add",
          "-A",
          "--",
          ...filePaths,
        ]);
      } else {
        yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);
      }

      const stagedSummary = yield* runGitStdout("GitCore.prepareCommitContext.stagedSummary", cwd, [
        "diff",
        "--cached",
        "--name-status",
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runGitStdout("GitCore.prepareCommitContext.stagedPatch", cwd, [
        "diff",
        "--cached",
        "--patch",
        "--minimal",
      ]);

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const commit: GitCoreShape["commit"] = (cwd, subject, body, _branchHint) =>
    Effect.gen(function* () {
      const args = ["commit", "-m", subject];
      const trimmedBody = body.trim();
      if (trimmedBody.length > 0) {
        args.push("-m", trimmedBody);
      }
      yield* runGit("GitCore.commit.commit", cwd, args);
      const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
        "rev-parse",
        "HEAD",
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha };
    });

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!publishRemoteName) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (hasRemoteBranch) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
        if (!publishRemoteName) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push because no git remote is configured for this repository.",
          );
        }
        yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
          "push",
          "-u",
          publishRemoteName,
          branch,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: true,
        };
      }

      const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (currentUpstream) {
        yield* runGit("GitCore.pushCurrentBranch.pushUpstream", cwd, [
          "push",
          currentUpstream.remoteName,
          `HEAD:${currentUpstream.upstreamBranch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: currentUpstream.upstreamRef,
          setUpstream: false,
        };
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    });

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git pull failed",
      });
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    });

  const readRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
    Effect.gen(function* () {
      const range = `${baseBranch}..HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdout("GitCore.readRangeContext.log", cwd, ["log", "--oneline", range]),
          runGitStdout("GitCore.readRangeContext.diffStat", cwd, ["diff", "--stat", range]),
          runGitStdout("GitCore.readRangeContext.diffPatch", cwd, [
            "diff",
            "--patch",
            "--minimal",
            range,
          ]),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    });

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    readRawConfigValue(cwd, key);

  const listBranches: GitCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      const repoContext = yield* repoContextResolver
        .resolve(input.cwd)
        .pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.listBranches.repoContext",
              input.cwd,
              ["rev-parse", "--show-toplevel"],
              error instanceof Error ? error.message : "Failed to resolve repository context.",
              error,
            ),
          ),
        );
      if (Option.isNone(repoContext)) {
        return { branches: [], backend: null, isRepo: false, hasOriginRemote: false };
      }

      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, number>())),
      );
      const localBranchResult = yield* executeGit(
        "GitCore.listBranches.branchNoColor",
        input.cwd,
        ["branch", "--no-color"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      );

      if (localBranchResult.code !== 0) {
        const stderr = localBranchResult.stderr.trim();
        if (stderr.toLowerCase().includes("not a git repository")) {
          return { branches: [], backend: null, isRepo: false, hasOriginRemote: false };
        }
        return yield* createGitCommandError(
          "GitCore.listBranches",
          input.cwd,
          ["branch", "--no-color"],
          stderr || "git branch failed",
        );
      }

      const remoteBranchResultEffect = executeGit(
        "GitCore.listBranches.remoteBranches",
        input.cwd,
        ["branch", "--no-color", "--remotes"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const remoteNamesResultEffect = executeGit(
        "GitCore.listBranches.remoteNames",
        input.cwd,
        ["remote"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
        yield* Effect.all(
          [
            executeGit(
              "GitCore.listBranches.defaultRef",
              input.cwd,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            executeGit(
              "GitCore.listBranches.worktreeList",
              input.cwd,
              ["worktree", "list", "--porcelain"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            remoteBranchResultEffect,
            remoteNamesResultEffect,
            branchRecencyPromise,
          ],
          { concurrency: "unbounded" },
        );

      const remoteNames =
        remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
      if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
        );
      }
      if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
        );
      }

      const defaultBranch =
        defaultRef.code === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const worktreeMap = new Map<string, string>();
      if (worktreeList.code === 0) {
        let currentPath: string | null = null;
        for (const line of worktreeList.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            const candidatePath = line.slice("worktree ".length);
            const exists = yield* pathExists(candidatePath);
            currentPath = exists ? candidatePath : null;
          } else if (line.startsWith("branch refs/heads/") && currentPath) {
            worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
          } else if (line === "") {
            currentPath = null;
          }
        }
      }

      const localBranches = localBranchResult.stdout
        .split("\n")
        .map(parseBranchLine)
        .filter((branch): branch is { name: string; current: boolean } => branch !== null)
        .map((branch) => ({
          name: branch.name,
          current: branch.current,
          isRemote: false,
          isDefault: branch.name === defaultBranch,
          worktreePath: worktreeMap.get(branch.name) ?? null,
        }))
        .toSorted((a, b) => {
          const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
          const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
          if (aPriority !== bPriority) return aPriority - bPriority;

          const aLastCommit = branchLastCommit.get(a.name) ?? 0;
          const bLastCommit = branchLastCommit.get(b.name) ?? 0;
          if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
          return a.name.localeCompare(b.name);
        });

      const remoteBranches =
        remoteBranchResult.code === 0
          ? remoteBranchResult.stdout
              .split("\n")
              .map(parseBranchLine)
              .filter((branch): branch is { name: string; current: boolean } => branch !== null)
              .map((branch) => {
                const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
                const remoteBranch: {
                  name: string;
                  current: boolean;
                  isRemote: boolean;
                  remoteName?: string;
                  isDefault: boolean;
                  worktreePath: string | null;
                } = {
                  name: branch.name,
                  current: false,
                  isRemote: true,
                  isDefault: false,
                  worktreePath: null,
                };
                if (parsedRemoteRef) {
                  remoteBranch.remoteName = parsedRemoteRef.remoteName;
                }
                return remoteBranch;
              })
              .toSorted((a, b) => {
                const aLastCommit = branchLastCommit.get(a.name) ?? 0;
                const bLastCommit = branchLastCommit.get(b.name) ?? 0;
                if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
                return a.name.localeCompare(b.name);
              })
          : [];

      const branches = [...localBranches, ...remoteBranches];

      return {
        branches,
        backend: repoContext.value.backend,
        isRepo: true,
        hasOriginRemote: remoteNames.includes("origin"),
      };
    });

  const createWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const targetBranch = input.newBranch ?? input.branch;
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const worktreePath =
        input.path ?? path.join(homeDir, ".t3", "worktrees", repoName, sanitizedBranch);
      const args = input.newBranch
        ? ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch]
        : ["worktree", "add", worktreePath, input.branch];

      yield* executeGit("GitCore.createWorktree", input.cwd, args, {
        fallbackErrorMessage: "git worktree add failed",
      });

      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    });

  const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = (input) =>
    Effect.gen(function* () {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitCore.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorMessage: "git fetch pull request branch failed",
        },
      );
    }).pipe(Effect.asVoid);

  const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = (input) =>
    Effect.gen(function* () {
      yield* runGit("GitCore.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);

      const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
      const targetRef = `${input.remoteName}/${input.remoteBranch}`;
      yield* runGit(
        "GitCore.fetchRemoteBranch.materialize",
        input.cwd,
        localBranchAlreadyExists
          ? ["branch", "--force", input.localBranch, targetRef]
          : ["branch", input.localBranch, targetRef],
      );
    }).pipe(Effect.asVoid);

  const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    runGit("GitCore.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitCoreShape["removeWorktree"] = (input) =>
    Effect.gen(function* () {
      const args = ["worktree", "remove"];
      if (input.force) {
        args.push("--force");
      }
      args.push(input.path);
      yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        ),
      );
    });

  const renameBranch: GitCoreShape["renameBranch"] = (input) =>
    Effect.gen(function* () {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitCore.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    });

  const createBranch: GitCoreShape["createBranch"] = (input) =>
    executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    }).pipe(Effect.asVoid);

  const checkoutBranch: GitCoreShape["checkoutBranch"] = (input) =>
    Effect.gen(function* () {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      // Refresh upstream refs in the background so checkout remains responsive.
      yield* Effect.forkScoped(
        refreshCheckedOutBranchUpstream(input.cwd).pipe(Effect.ignoreCause({ log: true })),
      );
    });

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  const jjStatusDetails: GitCoreShape["statusDetails"] = (cwd) =>
    Effect.gen(function* () {
      const bookmarkState = yield* resolveJjCurrentBookmarkState(cwd);
      const branch = bookmarkState.resolvedBranch;
      const excludedTopLevelNames = yield* repoContextResolver.resolve(cwd).pipe(
        Effect.map((repoContext) =>
          Option.isSome(repoContext)
            ? repoContext.value.excludedTopLevelNames
            : EMPTY_EXCLUDED_TOP_LEVEL_NAMES,
        ),
        Effect.catch(() => Effect.succeed(EMPTY_EXCLUDED_TOP_LEVEL_NAMES)),
      );

      const [summaryStdout, statStdout, upstream] = yield* Effect.all(
        [
          runJjStdout("GitCore.JJ.statusDetails.summary", cwd, ["diff", "--summary"]),
          runJjStdout("GitCore.JJ.statusDetails.stat", cwd, ["diff", "--stat"]),
          branch
            ? resolveConfiguredBookmarkUpstream(cwd, branch)
            : Effect.succeed(
                null as { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
              ),
        ],
        { concurrency: "unbounded" },
      );

      const changedFilesWithoutNumstat = new Set<string>();
      let hasWorkingTreeChanges = false;
      for (const line of summaryStdout.split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (trimmed.length <= 2) {
          continue;
        }
        const filePath = trimmed.slice(2).trim();
        if (filePath.length === 0) {
          continue;
        }
        if (isPathInExcludedTopLevelDirectory(filePath, excludedTopLevelNames)) {
          continue;
        }
        hasWorkingTreeChanges = true;
        changedFilesWithoutNumstat.add(filePath);
      }

      const diffStat = parseJjDiffStat(statStdout);
      const files = [...diffStat.files];
      for (const filePath of changedFilesWithoutNumstat) {
        if (!files.some((file) => file.path === filePath)) {
          files.push({ path: filePath, insertions: 0, deletions: 0 });
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      let aheadCount = 0;
      let behindCount = 0;
      if (branch && upstream) {
        const counts = yield* executeGit(
          "GitCore.JJ.statusDetails.revListCounts",
          cwd,
          [
            "rev-list",
            "--left-right",
            "--count",
            `refs/heads/${branch}...refs/remotes/${upstream.remoteName}/${upstream.upstreamBranch}`,
          ],
          { allowNonZeroExit: true },
        );
        if (counts.code === 0) {
          const [aheadRaw = "0", behindRaw = "0"] = counts.stdout.trim().split(/\s+/g);
          aheadCount = Number.parseInt(aheadRaw, 10) || 0;
          behindCount = Number.parseInt(behindRaw, 10) || 0;
        }
      } else if (branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(0)),
        );
      }

      return {
        branch,
        upstreamRef: upstream?.upstreamRef ?? null,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions: diffStat.insertions,
          deletions: diffStat.deletions,
        },
        hasUpstream: upstream !== null,
        aheadCount,
        behindCount,
      };
    });

  const jjStatus: GitCoreShape["status"] = (input) =>
    jjStatusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const jjPrepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd) =>
    Effect.gen(function* () {
      const stagedSummary = yield* runJjStdout("GitCore.JJ.prepareCommitContext.summary", cwd, [
        "diff",
        "--summary",
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runJjStdout("GitCore.JJ.prepareCommitContext.patch", cwd, [
        "diff",
        "--git",
      ]);

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const jjCommit: GitCoreShape["commit"] = (cwd, subject, body, branchHint) =>
    Effect.gen(function* () {
      const targetBranch = yield* resolveTargetBookmark(cwd, branchHint, "GitCore.JJ.commit", [
        "jj",
        "commit",
      ]);
      yield* runJj("GitCore.JJ.commit.commit", cwd, [
        "commit",
        "-m",
        buildCommitMessage(subject, body),
      ]);
      yield* runJj("GitCore.JJ.commit.moveBookmark", cwd, [
        "bookmark",
        "set",
        targetBranch,
        "--revision",
        "@-",
      ]);
      const commitSha = yield* runGitStdout("GitCore.JJ.commit.revParseHead", cwd, [
        "rev-parse",
        "HEAD",
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      return { commitSha };
    });

  const jjReadRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
    Effect.gen(function* () {
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runJjStdout("GitCore.JJ.readRangeContext.log", cwd, [
            "log",
            "-r",
            `${baseBranch}..@-`,
            "--no-graph",
            "-T",
            'commit_id.short() ++ " " ++ description.first_line() ++ "\\n"',
          ]),
          runJjStdout("GitCore.JJ.readRangeContext.diffStat", cwd, [
            "diff",
            "--stat",
            "--from",
            baseBranch,
            "--to",
            "@-",
          ]),
          runJjStdout("GitCore.JJ.readRangeContext.diffPatch", cwd, [
            "diff",
            "--git",
            "--from",
            baseBranch,
            "--to",
            "@-",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    });

  const jjListBranches: GitCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      const repoContext = yield* repoContextResolver
        .resolve(input.cwd)
        .pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.JJ.listBranches.repoContext",
              input.cwd,
              ["jj", "bookmark", "list"],
              error instanceof Error ? error.message : "Failed to resolve repository context.",
              error,
            ),
          ),
        );
      if (Option.isNone(repoContext)) {
        return { branches: [], backend: null, isRepo: false, hasOriginRemote: false };
      }

      const [bookmarkStdout, bookmarkState, branchLastCommit, remoteNames, defaultBranch] =
        yield* Effect.all(
          [
            runJjStdout("GitCore.JJ.listBranches.bookmarks", input.cwd, [
              "bookmark",
              "list",
              "-a",
              "-T",
              'name ++ "\\t" ++ remote ++ "\\n"',
            ]),
            resolveJjCurrentBookmarkState(input.cwd),
            readBranchRecency(input.cwd).pipe(
              Effect.catch(() => Effect.succeed(new Map<string, number>())),
            ),
            listRemoteNames(input.cwd).pipe(
              Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
            ),
            resolveDefaultBranchName(input.cwd, "origin").pipe(
              Effect.catch(() => Effect.succeed(null)),
            ),
          ],
          { concurrency: "unbounded" },
        );

      const currentBookmarkSet = new Set(bookmarkState.currentBookmarks);
      const managedPaths = new Map<string, string | null>();
      const rawBookmarks = parseJjBookmarkList(bookmarkStdout);

      const localBranches = [];
      const remoteBranches = [];
      for (const bookmark of rawBookmarks) {
        if (bookmark.remote === "git") {
          continue;
        }
        if (bookmark.remote === null) {
          if (!managedPaths.has(bookmark.name)) {
            managedPaths.set(
              bookmark.name,
              yield* readManagedWorkspacePath(input.cwd, bookmark.name),
            );
          }
          localBranches.push({
            name: bookmark.name,
            current: currentBookmarkSet.has(bookmark.name),
            isRemote: false,
            isDefault: bookmark.name === defaultBranch,
            worktreePath: managedPaths.get(bookmark.name) ?? null,
          });
          continue;
        }
        remoteBranches.push({
          name: `${bookmark.remote}/${bookmark.name}`,
          current: false,
          isRemote: true,
          remoteName: bookmark.remote,
          isDefault: bookmark.remote === "origin" && bookmark.name === defaultBranch,
          worktreePath: null,
        });
      }

      localBranches.sort((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) {
          return bLastCommit - aLastCommit;
        }
        return a.name.localeCompare(b.name);
      });
      remoteBranches.sort((a, b) => {
        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) {
          return bLastCommit - aLastCommit;
        }
        return a.name.localeCompare(b.name);
      });

      return {
        branches: [...localBranches, ...remoteBranches],
        backend: "jj" as const,
        isRepo: true,
        hasOriginRemote: remoteNames.includes("origin"),
      };
    });

  const jjFetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = (input) =>
    Effect.gen(function* () {
      yield* runJj("GitCore.JJ.fetchRemoteBranch.fetch", input.cwd, [
        "git",
        "fetch",
        "--remote",
        input.remoteName,
        "--branch",
        input.remoteBranch,
      ]);
      yield* runJj("GitCore.JJ.fetchRemoteBranch.materialize", input.cwd, [
        "bookmark",
        "set",
        input.localBranch,
        "--revision",
        toJjBookmarkRef(input.remoteName, input.remoteBranch),
      ]);
      yield* setBookmarkUpstreamConfig(
        input.cwd,
        input.localBranch,
        input.remoteName,
        input.remoteBranch,
      );
    }).pipe(Effect.asVoid);

  const jjSetBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    setBookmarkUpstreamConfig(input.cwd, input.branch, input.remoteName, input.remoteBranch);

  const jjCheckoutBranch: GitCoreShape["checkoutBranch"] = (input) =>
    Effect.gen(function* () {
      const dirty = yield* jjStatusDetails(input.cwd);
      if (dirty.hasWorkingTreeChanges) {
        return yield* createGitCommandError(
          "GitCore.JJ.checkoutBranch",
          input.cwd,
          ["jj", "new", input.branch],
          "Cannot switch JJ bookmarks with uncommitted working-copy changes. Create or use a dedicated workspace first.",
        );
      }

      const parsedRemoteRef = yield* parseRemoteRefForJj(input.cwd, input.branch);
      const targetBranch = parsedRemoteRef
        ? yield* ensureLocalBookmarkFromRef(input.cwd, input.branch)
        : input.branch;

      yield* runJj("GitCore.JJ.checkoutBranch.new", input.cwd, ["new", targetBranch]);
    });

  const jjCreateBranch: GitCoreShape["createBranch"] = (input) =>
    runJj("GitCore.JJ.createBranch", input.cwd, ["bookmark", "create", input.branch]).pipe(
      Effect.asVoid,
    );

  const jjListLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runJjStdout("GitCore.JJ.listLocalBranchNames", cwd, [
      "bookmark",
      "list",
      "-T",
      'name ++ "\\t" ++ remote ++ "\\n"',
    ]).pipe(
      Effect.map((stdout) =>
        parseJjBookmarkList(stdout)
          .filter((bookmark) => bookmark.remote === null)
          .map((bookmark) => bookmark.name)
          .sort((a, b) => a.localeCompare(b)),
      ),
    );

  const jjRenameBranch: GitCoreShape["renameBranch"] = (input) =>
    Effect.gen(function* () {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const existingNames = yield* jjListLocalBranchNames(input.cwd);
      let targetBranch = input.newBranch;
      if (existingNames.includes(targetBranch)) {
        let suffix = 1;
        while (existingNames.includes(`${input.newBranch}-${suffix}`)) {
          suffix += 1;
        }
        targetBranch = `${input.newBranch}-${suffix}`;
      }

      yield* runJj("GitCore.JJ.renameBranch.rename", input.cwd, [
        "bookmark",
        "rename",
        input.oldBranch,
        targetBranch,
      ]);

      const metadataKeys = ["remote", "merge", "gh-merge-base", "t3-workspace-path"] as const;
      for (const key of metadataKeys) {
        const value = yield* readRawConfigValue(input.cwd, `branch.${input.oldBranch}.${key}`);
        if (value) {
          yield* writeRawConfigValue(input.cwd, `branch.${targetBranch}.${key}`, value);
          yield* unsetRawConfigValue(input.cwd, `branch.${input.oldBranch}.${key}`);
        }
      }

      return { branch: targetBranch };
    });

  const jjCreateWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const repoContext = yield* repoContextResolver
        .resolve(input.cwd)
        .pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.JJ.createWorktree.repoContext",
              input.cwd,
              ["jj", "workspace", "add"],
              error instanceof Error ? error.message : "Failed to resolve JJ repo context.",
              error,
            ),
          ),
        );
      if (Option.isNone(repoContext)) {
        return yield* createGitCommandError(
          "GitCore.JJ.createWorktree",
          input.cwd,
          ["jj", "workspace", "add"],
          "Cannot create a JJ workspace outside a repository.",
        );
      }

      const baseBranch = yield* ensureLocalBookmarkFromRef(input.cwd, input.branch);
      const targetBranch = input.newBranch?.trim().length ? input.newBranch.trim() : baseBranch;
      if (input.newBranch?.trim().length) {
        yield* runJj("GitCore.JJ.createWorktree.createBookmark", input.cwd, [
          "bookmark",
          "set",
          targetBranch,
          "--revision",
          baseBranch,
        ]);
      }

      const existingManagedPath = yield* readManagedWorkspacePath(input.cwd, targetBranch);
      if (existingManagedPath) {
        return {
          worktree: {
            path: existingManagedPath,
            branch: targetBranch,
          },
        };
      }

      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(repoContext.value.gitRoot);
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const worktreePath =
        input.path ?? path.join(homeDir, ".t3", "worktrees", repoName, sanitizedBranch);
      yield* fileSystem
        .makeDirectory(path.dirname(worktreePath), { recursive: true })
        .pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.JJ.createWorktree.mkdir",
              input.cwd,
              ["jj", "workspace", "add"],
              error instanceof Error
                ? error.message
                : "Failed to create the JJ managed workspace directory.",
              error,
            ),
          ),
        );

      yield* runJj("GitCore.JJ.createWorktree.workspaceAdd", input.cwd, [
        "workspace",
        "add",
        worktreePath,
        "--name",
        sanitizedBranch,
        "-r",
        targetBranch,
      ]);
      yield* setManagedWorkspacePath(input.cwd, targetBranch, worktreePath);
      yield* repoContextResolver.invalidate(input.cwd, worktreePath);

      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    });

  const jjRemoveWorktree: GitCoreShape["removeWorktree"] = (input) =>
    Effect.gen(function* () {
      const entries = yield* readManagedWorkspaceConfigEntries(input.cwd);
      const managedEntry = entries.find((entry) => entry.path === input.path);
      if (!managedEntry) {
        return yield* createGitCommandError(
          "GitCore.JJ.removeWorktree",
          input.cwd,
          ["jj", "workspace", "forget"],
          "Only app-managed JJ workspaces can be removed.",
        );
      }
      yield* runJj("GitCore.JJ.removeWorktree.forget", input.path, ["workspace", "forget"]);
      yield* unsetManagedWorkspacePath(input.cwd, managedEntry.branch);
      yield* fileSystem
        .remove(input.path, { recursive: true })
        .pipe(
          Effect.mapError((error) =>
            createGitCommandError(
              "GitCore.JJ.removeWorktree.fsRemove",
              input.cwd,
              ["rm", "-rf", input.path],
              error instanceof Error ? error.message : "Failed to remove JJ workspace directory.",
              error,
            ),
          ),
        );
      yield* repoContextResolver.invalidate(input.cwd, input.path);
    });

  const jjFetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = (input) =>
    Effect.gen(function* () {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      const remoteBranch = input.branch;
      yield* executeGit(
        "GitCore.JJ.fetchPullRequestBranch.fetch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/remotes/${remoteName}/${remoteBranch}`,
        ],
        {
          fallbackErrorMessage: "git fetch pull request branch failed",
        },
      );
      yield* runJj("GitCore.JJ.fetchPullRequestBranch.import", input.cwd, ["git", "import"]);
      yield* runJj("GitCore.JJ.fetchPullRequestBranch.materialize", input.cwd, [
        "bookmark",
        "set",
        input.branch,
        "--revision",
        toJjBookmarkRef(remoteName, remoteBranch),
      ]);
    }).pipe(Effect.asVoid);

  const jjPushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const branch = yield* resolveTargetBookmark(
        cwd,
        fallbackBranch,
        "GitCore.JJ.pushCurrentBranch",
        ["jj", "git", "push"],
      );
      const configuredUpstream = yield* resolveConfiguredBookmarkUpstream(cwd, branch);
      const remoteName =
        configuredUpstream?.remoteName ??
        (yield* resolvePushRemoteName(cwd, branch).pipe(Effect.map((value) => value ?? "origin")));
      const remoteBranch = configuredUpstream?.upstreamBranch ?? branch;
      const hadUpstream = configuredUpstream !== null;
      const pushArgs =
        remoteBranch === branch
          ? ["git", "push", "--remote", remoteName, "--bookmark", branch, "--allow-new"]
          : ["git", "push", "--remote", remoteName, "--named", `${remoteBranch}=${branch}`];
      const result = yield* executeJj("GitCore.JJ.pushCurrentBranch.push", cwd, pushArgs, {
        allowNonZeroExit: true,
      });
      if (result.code !== 0) {
        return yield* createGitCommandError(
          "GitCore.JJ.pushCurrentBranch",
          cwd,
          ["jj", ...pushArgs],
          result.stderr.trim() || result.stdout.trim() || "jj git push failed",
        );
      }
      if (!hadUpstream) {
        yield* setBookmarkUpstreamConfig(cwd, branch, remoteName, remoteBranch);
      }

      const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (
        combinedOutput.includes("nothing changed") ||
        combinedOutput.includes("already matches")
      ) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          upstreamBranch: `${remoteName}/${remoteBranch}`,
        };
      }

      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${remoteName}/${remoteBranch}`,
        setUpstream: !hadUpstream,
      };
    });

  const jjPullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const branch = yield* resolveTargetBookmark(cwd, null, "GitCore.JJ.pullCurrentBranch", [
        "jj",
        "git",
        "fetch",
      ]);
      const upstream = yield* resolveConfiguredBookmarkUpstream(cwd, branch);
      if (!upstream) {
        return yield* createGitCommandError(
          "GitCore.JJ.pullCurrentBranch",
          cwd,
          ["jj", "git", "fetch"],
          "Current JJ bookmark has no upstream configured. Push with upstream first.",
        );
      }

      const details = yield* jjStatusDetails(cwd);
      if (details.hasWorkingTreeChanges) {
        return yield* createGitCommandError(
          "GitCore.JJ.pullCurrentBranch",
          cwd,
          ["jj", "new", branch],
          "Cannot pull into a JJ workspace with uncommitted working-copy changes.",
        );
      }

      const beforeSha = yield* resolveBookmarkGitSha(cwd, branch);
      yield* runJj("GitCore.JJ.pullCurrentBranch.fetch", cwd, [
        "git",
        "fetch",
        "--remote",
        upstream.remoteName,
        "--branch",
        upstream.upstreamBranch,
      ]);
      yield* runJj("GitCore.JJ.pullCurrentBranch.materialize", cwd, [
        "bookmark",
        "set",
        branch,
        "--revision",
        toJjBookmarkRef(upstream.remoteName, upstream.upstreamBranch),
      ]);
      yield* runJj("GitCore.JJ.pullCurrentBranch.checkout", cwd, ["new", branch]);
      const afterSha = yield* resolveBookmarkGitSha(cwd, branch);

      return {
        status:
          beforeSha !== null && afterSha !== null && beforeSha === afterSha
            ? "skipped_up_to_date"
            : "pulled",
        branch,
        upstreamBranch: upstream.upstreamRef,
      };
    });

  const jjReadConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    readRawConfigValue(cwd, key);

  const jjEnsureRemote: GitCoreShape["ensureRemote"] = (input) => ensureRemote(input);

  const nativeCore = {
    status,
    statusDetails,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    listBranches,
    createWorktree,
    fetchPullRequestBranch,
    ensureRemote,
    fetchRemoteBranch,
    setBranchUpstream,
    removeWorktree,
    renameBranch,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies GitCoreShape;

  const jujutsuCore = {
    status: jjStatus,
    statusDetails: jjStatusDetails,
    prepareCommitContext: jjPrepareCommitContext,
    commit: jjCommit,
    pushCurrentBranch: jjPushCurrentBranch,
    pullCurrentBranch: jjPullCurrentBranch,
    readRangeContext: jjReadRangeContext,
    readConfigValue: jjReadConfigValue,
    listBranches: jjListBranches,
    createWorktree: jjCreateWorktree,
    fetchPullRequestBranch: jjFetchPullRequestBranch,
    ensureRemote: jjEnsureRemote,
    fetchRemoteBranch: jjFetchRemoteBranch,
    setBranchUpstream: jjSetBranchUpstream,
    removeWorktree: jjRemoveWorktree,
    renameBranch: jjRenameBranch,
    createBranch: jjCreateBranch,
    checkoutBranch: jjCheckoutBranch,
    initRepo,
    listLocalBranchNames: jjListLocalBranchNames,
  } satisfies GitCoreShape;

  const resolveBackendForCwd = (cwd: string): Effect.Effect<"git" | "jj" | null, GitCommandError> =>
    repoContextResolver.resolve(cwd).pipe(
      Effect.map((repoContext) => (Option.isSome(repoContext) ? repoContext.value.backend : null)),
      Effect.mapError((error) =>
        createGitCommandError(
          "GitCore.resolveBackend",
          cwd,
          ["rev-parse", "--show-toplevel"],
          error instanceof Error ? error.message : "Failed to resolve repository context.",
          error,
        ),
      ),
    );

  return {
    status: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.status(input) : nativeCore.status(input),
        ),
      ),
    statusDetails: (cwd) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.statusDetails(cwd) : nativeCore.statusDetails(cwd),
        ),
      ),
    prepareCommitContext: (cwd, filePaths) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.prepareCommitContext(cwd, filePaths)
            : nativeCore.prepareCommitContext(cwd, filePaths),
        ),
      ),
    commit: (cwd, subject, body, branchHint) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.commit(cwd, subject, body, branchHint)
            : nativeCore.commit(cwd, subject, body, branchHint),
        ),
      ),
    pushCurrentBranch: (cwd, fallbackBranch) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.pushCurrentBranch(cwd, fallbackBranch)
            : nativeCore.pushCurrentBranch(cwd, fallbackBranch),
        ),
      ),
    pullCurrentBranch: (cwd) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.pullCurrentBranch(cwd) : nativeCore.pullCurrentBranch(cwd),
        ),
      ),
    readRangeContext: (cwd, baseBranch) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.readRangeContext(cwd, baseBranch)
            : nativeCore.readRangeContext(cwd, baseBranch),
        ),
      ),
    readConfigValue: (cwd, key) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.readConfigValue(cwd, key)
            : nativeCore.readConfigValue(cwd, key),
        ),
      ),
    listBranches: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) => {
          if (backend === "jj") {
            return jujutsuCore.listBranches(input);
          }
          return nativeCore.listBranches(input);
        }),
      ),
    createWorktree: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.createWorktree(input) : nativeCore.createWorktree(input),
        ),
      ),
    fetchPullRequestBranch: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.fetchPullRequestBranch(input)
            : nativeCore.fetchPullRequestBranch(input),
        ),
      ),
    ensureRemote: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.ensureRemote(input) : nativeCore.ensureRemote(input),
        ),
      ),
    fetchRemoteBranch: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.fetchRemoteBranch(input)
            : nativeCore.fetchRemoteBranch(input),
        ),
      ),
    setBranchUpstream: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.setBranchUpstream(input)
            : nativeCore.setBranchUpstream(input),
        ),
      ),
    removeWorktree: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.removeWorktree(input) : nativeCore.removeWorktree(input),
        ),
      ),
    renameBranch: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.renameBranch(input) : nativeCore.renameBranch(input),
        ),
      ),
    createBranch: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.createBranch(input) : nativeCore.createBranch(input),
        ),
      ),
    checkoutBranch: (input) =>
      resolveBackendForCwd(input.cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj" ? jujutsuCore.checkoutBranch(input) : nativeCore.checkoutBranch(input),
        ),
      ),
    initRepo,
    listLocalBranchNames: (cwd) =>
      resolveBackendForCwd(cwd).pipe(
        Effect.flatMap((backend) =>
          backend === "jj"
            ? jujutsuCore.listLocalBranchNames(cwd)
            : nativeCore.listLocalBranchNames(cwd),
        ),
      ),
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore);
