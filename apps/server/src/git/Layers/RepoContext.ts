import { Cache, Data, Duration, Effect, Exit, Layer, Option, Path, Ref } from "effect";

import { isCommandNotFoundError } from "../../commandErrors.ts";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";
import { RepoContextError } from "../Errors.ts";
import {
  DEFAULT_REPO_EXCLUDED_TOP_LEVEL_NAMES,
  RepoContextResolver,
  type RepoContext,
  type RepoContextResolverShape,
} from "../Services/RepoContext.ts";

const REPO_CONTEXT_TTL = Duration.seconds(5);
const REPO_CONTEXT_MAX_KEYS = 256;
const DETECTION_TIMEOUT_MS = 5_000;
const DETECTION_MAX_BUFFER_BYTES = 65_536;

class RepoProbeExecutionError extends Data.TaggedError("RepoProbeExecutionError")<{
  readonly cause: unknown;
}> {}

function normalizeRawRepoCommandEnv(
  repoContext: Option.Option<RepoContext>,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (Option.isNone(repoContext) || repoContext.value.backend !== "jj") {
    return env;
  }

  return {
    ...process.env,
    ...env,
    GIT_DIR: repoContext.value.gitDir,
    GIT_WORK_TREE: repoContext.value.workspaceRoot,
  };
}

const makeRepoContextLive = Effect.gen(function* () {
  const path = yield* Path.Path;
  const cacheKeys = yield* Ref.make(new Set<string>());
  const normalizePath = (input: string): string => path.resolve(input);
  const toAbsolutePath = (value: string, cwd: string): string =>
    path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const deriveGitRootFromGitDir = (gitDir: string): string =>
    path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
  const isSamePathOrDescendant = (candidate: string, parentPath: string): boolean =>
    candidate === parentPath || candidate.startsWith(`${parentPath}${path.sep}`);
  const matchesInvalidationPath = (
    cacheKey: string,
    normalizedPaths: ReadonlyArray<string>,
  ): boolean =>
    normalizedPaths.some(
      (targetPath) =>
        isSamePathOrDescendant(cacheKey, targetPath) ||
        isSamePathOrDescendant(targetPath, cacheKey),
    );

  const runRepoProbe = (input: {
    command: "git" | "jj";
    args: ReadonlyArray<string>;
    cwd: string;
    failureDetail: string;
    allowMissingCommand?: boolean;
  }): Effect.Effect<ProcessRunResult | null, RepoContextError> =>
    Effect.tryPromise({
      try: () =>
        runProcess(input.command, input.args, {
          cwd: input.cwd,
          timeoutMs: DETECTION_TIMEOUT_MS,
          allowNonZeroExit: true,
          maxBufferBytes: DETECTION_MAX_BUFFER_BYTES,
        }),
      catch: (cause) => new RepoProbeExecutionError({ cause }),
    }).pipe(
      Effect.catchTag("RepoProbeExecutionError", ({ cause }) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (input.allowMissingCommand && isCommandNotFoundError(error, input.command)) {
          return Effect.succeed(null);
        }
        return Effect.fail(
          new RepoContextError({
            cwd: input.cwd,
            detail: `${input.failureDetail}: ${error instanceof Error ? error.message : "unknown error"}`,
            cause: error,
          }),
        );
      }),
    );

  const detectJjRepoContext = (
    cwd: string,
  ): Effect.Effect<Option.Option<RepoContext>, RepoContextError> =>
    Effect.gen(function* () {
      const workspaceRootResult = yield* runRepoProbe({
        command: "jj",
        args: ["workspace", "root"],
        cwd,
        failureDetail: "Failed to resolve JJ workspace root",
        allowMissingCommand: true,
      });
      if (!workspaceRootResult) {
        return Option.none();
      }

      if (workspaceRootResult.timedOut) {
        return yield* new RepoContextError({
          cwd,
          detail: "Timed out while resolving JJ workspace root.",
        });
      }
      if (workspaceRootResult.code !== 0) {
        return Option.none();
      }

      const workspaceRoot = workspaceRootResult.stdout.trim();
      if (workspaceRoot.length === 0) {
        return yield* new RepoContextError({
          cwd,
          detail: "JJ workspace root resolution returned an empty path.",
        });
      }

      const gitRootResult = yield* runRepoProbe({
        command: "jj",
        args: ["git", "root"],
        cwd,
        failureDetail:
          "JJ repository is unsupported because the backing Git directory could not be resolved",
      });
      if (!gitRootResult) {
        return Option.none();
      }

      if (gitRootResult.timedOut) {
        return yield* new RepoContextError({
          cwd,
          detail:
            "JJ repository is unsupported because resolving the backing Git directory timed out.",
        });
      }
      if (gitRootResult.code !== 0) {
        return yield* new RepoContextError({
          cwd,
          detail:
            gitRootResult.stderr.trim() ||
            "JJ repository is unsupported because the backing Git directory could not be resolved.",
        });
      }

      const gitDirValue = gitRootResult.stdout.trim();
      if (gitDirValue.length === 0) {
        return yield* new RepoContextError({
          cwd,
          detail: "JJ repository is unsupported because `jj git root` returned an empty path.",
        });
      }

      const resolvedWorkspaceRoot = toAbsolutePath(workspaceRoot, cwd);
      const gitDir = toAbsolutePath(gitDirValue, resolvedWorkspaceRoot);
      return Option.some({
        backend: "jj",
        workspaceRoot: resolvedWorkspaceRoot,
        gitRoot: deriveGitRootFromGitDir(gitDir),
        gitDir,
        excludedTopLevelNames: new Set(DEFAULT_REPO_EXCLUDED_TOP_LEVEL_NAMES),
      });
    });

  const detectGitRepoContext = (
    cwd: string,
  ): Effect.Effect<Option.Option<RepoContext>, RepoContextError> =>
    Effect.gen(function* () {
      const result = yield* runRepoProbe({
        command: "git",
        args: [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--absolute-git-dir",
          "--git-common-dir",
        ],
        cwd,
        failureDetail: "Failed to resolve Git repository context",
      });
      if (!result) {
        return Option.none();
      }

      if (result.timedOut) {
        return yield* new RepoContextError({
          cwd,
          detail: "Timed out while resolving Git repository context.",
        });
      }
      if (result.code !== 0) {
        return Option.none();
      }

      const [workspaceRootRaw = "", gitDirRaw = "", gitCommonDirRaw = ""] = result.stdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (workspaceRootRaw.length === 0 || gitDirRaw.length === 0) {
        return yield* new RepoContextError({
          cwd,
          detail: "Git repository context resolution returned incomplete output.",
        });
      }

      const workspaceRoot = toAbsolutePath(workspaceRootRaw, cwd);
      const gitDir = toAbsolutePath(gitDirRaw, workspaceRoot);
      const gitCommonDir =
        gitCommonDirRaw.length > 0 ? toAbsolutePath(gitCommonDirRaw, workspaceRoot) : gitDir;

      return Option.some({
        backend: "git",
        workspaceRoot,
        gitRoot: deriveGitRootFromGitDir(gitCommonDir),
        gitDir,
        excludedTopLevelNames: new Set([".git"]),
      });
    });

  const detectRepoContext = (
    cwd: string,
  ): Effect.Effect<Option.Option<RepoContext>, RepoContextError> =>
    detectJjRepoContext(cwd).pipe(
      Effect.flatMap((repoContext) =>
        Option.match(repoContext, {
          onNone: () => detectGitRepoContext(cwd),
          onSome: () => Effect.succeed(repoContext),
        }),
      ),
    );

  const repoContextCache = yield* Cache.makeWith<
    string,
    Option.Option<RepoContext>,
    RepoContextError
  >({
    capacity: REPO_CONTEXT_MAX_KEYS,
    lookup: (cwd) => detectRepoContext(cwd),
    timeToLive: (exit) => (Exit.isSuccess(exit) ? REPO_CONTEXT_TTL : Duration.zero),
  });

  const addCacheKey = (key: string) =>
    Ref.update(cacheKeys, (current) => {
      if (current.has(key)) {
        return current;
      }
      const next = new Set(current);
      next.add(key);
      return next;
    });

  const resolve: RepoContextResolverShape["resolve"] = Effect.fnUntraced(function* (cwd) {
    const key = normalizePath(cwd);
    yield* addCacheKey(key);
    return yield* Cache.get(repoContextCache, key);
  });

  const resolveRawCommandContext: RepoContextResolverShape["resolveRawCommandContext"] =
    Effect.fnUntraced(function* (input) {
      const repoContext = yield* resolve(input.cwd);
      const env = normalizeRawRepoCommandEnv(repoContext, input.env);
      return Option.match(repoContext, {
        onNone: () => ({
          kind: "non_repo" as const,
          cwd: input.cwd,
          ...(env ? { env } : {}),
        }),
        onSome: (resolvedRepoContext) => ({
          kind: "repo" as const,
          cwd: input.cwd,
          repoContext: resolvedRepoContext,
          ...(env ? { env } : {}),
        }),
      });
    });

  const invalidate: RepoContextResolverShape["invalidate"] = Effect.fnUntraced(function* (
    ...pathsToInvalidate
  ) {
    const normalizedPaths = pathsToInvalidate
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map(normalizePath);
    if (normalizedPaths.length === 0) {
      return;
    }

    const currentKeys = yield* Ref.get(cacheKeys);
    const keysToInvalidate = [...currentKeys].filter((cacheKey) =>
      matchesInvalidationPath(cacheKey, normalizedPaths),
    );
    if (keysToInvalidate.length === 0) {
      return;
    }

    yield* Effect.forEach(
      keysToInvalidate,
      (cacheKey) => Cache.invalidate(repoContextCache, cacheKey),
      {
        discard: true,
      },
    );
    yield* Ref.update(cacheKeys, (current) => {
      const next = new Set(current);
      for (const cacheKey of keysToInvalidate) {
        next.delete(cacheKey);
      }
      return next;
    });
  });

  return {
    resolve,
    resolveRawCommandContext,
    invalidate,
  } satisfies RepoContextResolverShape;
});

export const RepoContextLive = Layer.effect(RepoContextResolver, makeRepoContextLive);
