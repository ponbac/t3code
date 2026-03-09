import { mkdir, rm } from "node:fs/promises";
import {
  type GitStatusResult,
  type VcsCapabilities,
  type VcsStatusInput,
  type VcsCheckoutRefInput,
  type VcsCreateWorkspaceInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { Effect, Layer, Path } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { VcsUnsupportedError } from "../Errors.ts";
import { VcsCommandError, type VcsServiceError } from "../Errors.ts";
import {
  buildJjCapabilities,
  buildJjRevision,
  countJjRevset,
  DEFAULT_JJ_TIMEOUT_MS,
  isGitHubRemoteUrl,
  type JjRemoteInfo,
  listJjBookmarks,
  parsePullRequestList,
  readCurrentJjBaseBookmarks,
  resolveJjPushRemote,
} from "../jj.ts";
import { VcsCore, type VcsCoreShape } from "../Services/VcsCore.ts";
import { VcsProcess } from "../Services/VcsProcess.ts";
import { VcsResolver } from "../Services/VcsResolver.ts";

export const GIT_VCS_CAPABILITIES: VcsCapabilities = {
  supportsCommit: true,
  supportsPush: true,
  supportsPull: true,
  supportsCreatePullRequest: true,
  supportsCreateFeatureRef: true,
  supportsCreateWorkspace: true,
  supportsRemoveWorkspace: true,
  supportsCreateRef: true,
  supportsCheckoutRef: true,
  supportsInit: true,
  supportsCheckpointing: true,
};

function toVcsServiceError(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly command: string;
}) {
  return (error: unknown): VcsServiceError => {
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (((error as { readonly _tag?: string })._tag === "VcsCommandError") ||
        ((error as { readonly _tag?: string })._tag === "VcsUnsupportedError"))
    ) {
      return error as VcsServiceError;
    }

    return new VcsCommandError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      detail: error instanceof Error ? error.message : String(error),
      ...(error !== undefined ? { cause: error } : {}),
    });
  };
}

function sanitizeWorkspaceFragment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/@/g, "-");
  const cleaned = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "");
  return cleaned.length > 0 ? cleaned : "workspace";
}

function toGitVcsStatus(input: {
  readonly status: GitStatusResult;
  readonly capabilities: VcsCapabilities;
}): VcsStatusResult {
  return {
    backend: "git",
    capabilities: input.capabilities,
    refName: input.status.branch,
    refKind: input.status.branch ? "branch" : null,
    hasWorkingTreeChanges: input.status.hasWorkingTreeChanges,
    workingTree: input.status.workingTree,
    hasUpstream: input.status.hasUpstream,
    aheadCount: input.status.aheadCount,
    behindCount: input.status.behindCount,
    pr: input.status.pr
      ? {
          number: input.status.pr.number,
          title: input.status.pr.title,
          url: input.status.pr.url,
          baseRef: input.status.pr.baseBranch,
          headRef: input.status.pr.headBranch,
          state: input.status.pr.state,
        }
      : null,
  };
}

const makeVcsCore = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;
  const gitHubCli = yield* GitHubCli;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess;
  const vcsResolver = yield* VcsResolver;

  const resolve = vcsResolver.resolve;

  const runJj = (
    cwd: string,
    args: ReadonlyArray<string>,
    operation: string,
    allowNonZeroExit = false,
  ) =>
    vcsProcess.execute({
      operation,
      command: "jj",
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs: DEFAULT_JJ_TIMEOUT_MS,
    });

  const resolveJjActionBookmark = (input: VcsStatusInput, currentBaseBookmarks: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const requestedRefName = input.contextRefName?.trim();
      if (requestedRefName) {
        if (input.contextRefKind && input.contextRefKind !== "bookmark") {
          return yield* new VcsUnsupportedError({
            operation: "VcsCore.resolveJjActionBookmark",
            cwd: input.cwd,
            detail: "Only local jj bookmarks can be used as the action context.",
          });
        }
        if (!currentBaseBookmarks.includes(requestedRefName)) {
          return yield* new VcsUnsupportedError({
            operation: "VcsCore.resolveJjActionBookmark",
            cwd: input.cwd,
            detail:
              "The selected bookmark is not attached to the current jj workspace stack. Open or create a workspace for that bookmark first.",
          });
        }
        return requestedRefName;
      }
      return currentBaseBookmarks.length === 1 ? (currentBaseBookmarks[0] ?? null) : null;
    });

  const resolveJjPrSupport = (cwd: string, remote: JjRemoteInfo | null) =>
    Effect.gen(function* () {
      if (!remote || !isGitHubRemoteUrl(remote.url)) {
        return false;
      }
      const defaultBranch = yield* gitHubCli.getDefaultBranch({ cwd }).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      return defaultBranch !== null;
    });

  const findLatestJjPr = (cwd: string, bookmarkName: string) =>
    Effect.gen(function* () {
      const stdout = yield* gitHubCli
        .execute({
          cwd,
          args: [
            "pr",
            "list",
            "--head",
            bookmarkName,
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt",
          ],
        })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.catch(() => Effect.succeed("")),
        );

      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        return null;
      }

      const parsedJson = yield* Effect.sync(() => {
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          return null;
        }
      });
      if (parsedJson === null) {
        return null;
      }

      const parsed = parsePullRequestList(parsedJson).toSorted((left, right) => {
        const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
        const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
        return rightUpdated - leftUpdated;
      });
      return parsed.find((entry) => entry.state === "open") ?? parsed[0] ?? null;
    });

  const status: VcsCoreShape["status"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        const statusResult = yield* gitManager.status({ cwd: input.cwd }).pipe(
          Effect.mapError(
            toVcsServiceError({
              operation: "VcsCore.status",
              cwd: input.cwd,
              command: "git status",
            }),
          ),
        );
        return toGitVcsStatus({
          status: statusResult,
          capabilities: GIT_VCS_CAPABILITIES,
        });
      }

      const [gitStatus, currentBaseBookmarks, bookmarkRows, pushRemote] = yield* Effect.all(
        [
          gitCore.status({ cwd: input.cwd }).pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.status",
                cwd: input.cwd,
                command: "git status",
              }),
            ),
          ),
          readCurrentJjBaseBookmarks(runJj, input.cwd, "VcsCore.readCurrentJjBaseBookmarks"),
          listJjBookmarks(runJj, input.cwd, "VcsCore.listJjBookmarks"),
          resolveJjPushRemote(runJj, input.cwd, {
            config: "VcsCore.resolveJjPushRemote.config",
            remotes: "VcsCore.resolveJjPushRemote.remotes",
          }),
        ],
        { concurrency: "unbounded" },
      );
      const displayBookmark = currentBaseBookmarks[0] ?? null;
      const actionBookmark = yield* resolveJjActionBookmark(input, currentBaseBookmarks);
      const supportsCreatePullRequest = yield* resolveJjPrSupport(input.cwd, pushRemote);
      const capabilities = buildJjCapabilities(supportsCreatePullRequest);
      const hasUpstream =
        !!actionBookmark &&
        !!pushRemote &&
        bookmarkRows.some(
          (row) => row.name?.trim() === actionBookmark && row.remote?.trim() === pushRemote.name,
        );
      const aheadCount = !actionBookmark || !pushRemote
        ? 0
        : hasUpstream
          ? yield* countJjRevset(
              runJj,
              input.cwd,
              `${actionBookmark}@${pushRemote.name}..${actionBookmark}`,
              "VcsCore.status.jjAheadCount",
            ).pipe(Effect.catch(() => Effect.succeed(0)))
          : yield* countJjRevset(
              runJj,
              input.cwd,
              `heads(::${actionBookmark} & remote_bookmarks(remote=${pushRemote.name}))..${actionBookmark}`,
              "VcsCore.status.jjAheadCountFromAncestor",
            ).pipe(Effect.catch(() => Effect.succeed(0)));
      const behindCount = !actionBookmark || !pushRemote || !hasUpstream
        ? 0
        : yield* countJjRevset(
            runJj,
            input.cwd,
            `${actionBookmark}..${actionBookmark}@${pushRemote.name}`,
            "VcsCore.status.jjBehindCount",
          ).pipe(Effect.catch(() => Effect.succeed(0)));
      const prInfo =
        actionBookmark && supportsCreatePullRequest
          ? yield* findLatestJjPr(input.cwd, actionBookmark)
          : null;
      return {
        backend: "jj",
        capabilities,
        refName: displayBookmark,
        refKind: displayBookmark ? "bookmark" : null,
        hasWorkingTreeChanges: gitStatus.hasWorkingTreeChanges,
        workingTree: gitStatus.workingTree,
        hasUpstream,
        aheadCount,
        behindCount,
        pr: prInfo
          ? {
              number: prInfo.number,
              title: prInfo.title,
              url: prInfo.url,
              baseRef: prInfo.baseRefName,
              headRef: prInfo.headRefName,
              state: prInfo.state,
            }
          : null,
      };
    });

  const listRefs: VcsCoreShape["listRefs"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        const result = yield* gitCore.listBranches({ cwd: input.cwd }).pipe(
          Effect.mapError(
            toVcsServiceError({
              operation: "VcsCore.listRefs",
              cwd: input.cwd,
              command: "git branch",
            }),
          ),
        );
        return {
          backend: "git",
          capabilities: GIT_VCS_CAPABILITIES,
          refs: result.branches.map(
            (branch) =>
              ({
                name: branch.name,
                kind: branch.isRemote ? "remoteBranch" : "branch",
                current: branch.current,
                isDefault: branch.isDefault,
                ...(branch.remoteName ? { remoteName: branch.remoteName } : {}),
                workspacePath: branch.worktreePath,
              }) satisfies VcsRef,
          ),
          isRepo: result.isRepo,
        } satisfies VcsListRefsResult;
      }

      const [bookmarkRows, currentBaseBookmarks, pushRemote] = yield* Effect.all(
        [
          listJjBookmarks(runJj, input.cwd, "VcsCore.listJjBookmarks"),
          readCurrentJjBaseBookmarks(runJj, input.cwd, "VcsCore.readCurrentJjBaseBookmarks"),
          resolveJjPushRemote(runJj, input.cwd, {
            config: "VcsCore.resolveJjPushRemote.config",
            remotes: "VcsCore.resolveJjPushRemote.remotes",
          }),
        ],
        { concurrency: "unbounded" },
      );
      const currentBaseBookmarkSet = new Set(currentBaseBookmarks);
      const capabilities = buildJjCapabilities(
        yield* resolveJjPrSupport(input.cwd, pushRemote),
      );
      const refs = bookmarkRows
        .flatMap((bookmark) => {
          const name = bookmark.name?.trim();
          if (!name) return [];
          const remoteName = bookmark.remote?.trim();
          const refName = remoteName ? `${name}@${remoteName}` : name;
          return [
            {
              name: refName,
              kind: remoteName ? "remoteBookmark" : "bookmark",
              current: !remoteName && currentBaseBookmarkSet.has(name),
              isDefault: name === "main" || name === "master",
              ...(remoteName ? { remoteName } : {}),
              workspacePath: null,
            } satisfies VcsRef,
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));

      return {
        backend: "jj",
        capabilities,
        refs,
        isRepo: true,
      } satisfies VcsListRefsResult;
    });

  const createWorkspace: VcsCoreShape["createWorkspace"] = (input: VcsCreateWorkspaceInput) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        const result = yield* gitCore
          .createWorktree({
            cwd: input.cwd,
            branch: input.refName,
            newBranch: input.newRefName ?? input.refName,
            path: input.path ?? null,
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.createWorkspace",
                cwd: input.cwd,
                command: "git worktree add",
              }),
            ),
          );
        return {
          backend: "git",
          workspace: {
            path: result.worktree.path,
            refName: result.worktree.branch,
            refKind: "branch",
          },
        };
      }

      const repoName = path.basename(resolution.workspaceRoot);
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const workspacePath =
        input.path ??
        path.join(homeDir, ".t3", "workspaces", repoName, sanitizeWorkspaceFragment(input.refName));
      const workspaceName = path.basename(workspacePath);
      yield* Effect.tryPromise({
        try: () => mkdir(path.dirname(workspacePath), { recursive: true }),
        catch: (error) =>
          new VcsCommandError({
            operation: "VcsCore.createWorkspace",
            command: "mkdir",
            cwd: input.cwd,
            detail:
              error instanceof Error
                ? error.message
                : "Failed to prepare jj workspace parent directory.",
            ...(error !== undefined ? { cause: error } : {}),
          }),
      });
      yield* runJj(
        input.cwd,
        [
          "workspace",
          "add",
          "--name",
          workspaceName,
          "--revision",
          buildJjRevision(input.refName, input.refKind),
          workspacePath,
        ],
        "VcsCore.createWorkspace",
      );
      return {
        backend: "jj",
        workspace: {
          path: workspacePath,
          refName: input.refName,
          refKind: input.refKind,
        },
      };
    });

  const removeWorkspace: VcsCoreShape["removeWorkspace"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        return yield* gitCore
          .removeWorktree({
            cwd: input.cwd,
            path: input.path,
            ...(input.force !== undefined ? { force: input.force } : {}),
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.removeWorkspace",
                cwd: input.cwd,
                command: "git worktree remove",
              }),
            ),
          );
      }

      const workspaceName = path.basename(input.path);
      yield* runJj(
        input.cwd,
        ["workspace", "forget", workspaceName],
        "VcsCore.removeWorkspace",
      ).pipe(
        Effect.catch((error) => {
          const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
          return detail.includes("no such file or directory") || detail.includes("no such workspace")
            ? Effect.void
            : Effect.fail(error);
        }),
      );
      yield* Effect.tryPromise({
        try: () =>
          rm(input.path, {
            recursive: true,
            force: input.force ?? true,
          }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
    });

  const createRef: VcsCoreShape["createRef"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        return yield* gitCore
          .createBranch({
            cwd: input.cwd,
            branch: input.refName,
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.createRef",
                cwd: input.cwd,
                command: "git branch",
              }),
            ),
          );
      }
      return yield* new VcsUnsupportedError({
        operation: "VcsCore.createRef",
        cwd: input.cwd,
        detail: "Creating jj bookmarks is not enabled in v1.",
      });
    });

  const checkoutRef: VcsCoreShape["checkoutRef"] = (input: VcsCheckoutRefInput) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        return yield* gitCore
          .checkoutBranch({
            cwd: input.cwd,
            branch: input.refName,
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.checkoutRef",
                cwd: input.cwd,
                command: "git checkout",
              }),
            ),
          );
      }
      return yield* new VcsUnsupportedError({
        operation: "VcsCore.checkoutRef",
        cwd: input.cwd,
        detail: "Checking out jj bookmarks is not enabled in v1.",
      });
    });

  const init: VcsCoreShape["init"] = (input) =>
    Effect.gen(function* () {
      if (input.backend === "jj") {
        yield* vcsProcess.execute({
          operation: "VcsCore.init",
          command: "jj",
          cwd: input.cwd,
          args: ["git", "init", "--colocate", "."],
          timeoutMs: DEFAULT_JJ_TIMEOUT_MS,
        });
        return;
      }
      return yield* gitCore.initRepo({ cwd: input.cwd }).pipe(
        Effect.mapError(
          toVcsServiceError({
            operation: "VcsCore.init",
            cwd: input.cwd,
            command: "git init",
          }),
        ),
      );
    });

  return {
    status,
    listRefs,
    createWorkspace,
    removeWorkspace,
    createRef,
    checkoutRef,
    init,
  } satisfies VcsCoreShape;
});

export const VcsCoreLive = Layer.effect(VcsCore, makeVcsCore);
