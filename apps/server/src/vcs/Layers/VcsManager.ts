import { randomUUID } from "node:crypto";

import {
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import type { VcsRunActionResult } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { VcsCommandError, VcsUnsupportedError } from "../Errors.ts";
import {
  DEFAULT_JJ_TIMEOUT_MS,
  isGitHubRemoteUrl,
  listJjBookmarks,
  parsePullRequestList,
  readNearestAncestorRemoteBookmarkNames,
  resolveJjPushRemote,
} from "../jj.ts";
import { VcsCore } from "../Services/VcsCore.ts";
import { VcsManager, type VcsManagerShape } from "../Services/VcsManager.ts";
import { VcsProcess } from "../Services/VcsProcess.ts";
import { VcsResolver } from "../Services/VcsResolver.ts";

interface CommitSuggestion {
  readonly subject: string;
  readonly body: string;
  readonly commitMessage: string;
  readonly refName?: string | undefined;
}

function vcsCommandError(
  operation: string,
  cwd: string,
  command: string,
  detail: string,
  cause?: unknown,
) {
  return new VcsCommandError({
    operation,
    cwd,
    command,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function sanitizeCommitSuggestion(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): CommitSuggestion {
  const subject = (generated.subject.trim().split(/\r?\n/g)[0] ?? "Update project files")
    .replace(/[.]+$/g, "")
    .trim()
    .slice(0, 72)
    .trimEnd();
  const safeSubject = subject.length > 0 ? subject : "Update project files";
  const body = generated.body.trim();
  return {
    subject: safeSubject,
    body,
    commitMessage: formatCommitMessage(safeSubject, body),
    ...(generated.branch ? { refName: sanitizeFeatureBranchName(generated.branch) } : {}),
  };
}

function toVcsRunActionResult(result: {
  action: "commit" | "commit_push" | "commit_push_pr";
  branch: { status: "created" | "skipped_not_requested"; name?: string | undefined };
  commit: { status: "created" | "skipped_no_changes"; commitSha?: string | undefined; subject?: string | undefined };
  push: {
    status: "pushed" | "skipped_not_requested" | "skipped_up_to_date";
    branch?: string | undefined;
    upstreamBranch?: string | undefined;
    setUpstream?: boolean | undefined;
  };
  pr: {
    status: "created" | "opened_existing" | "skipped_not_requested";
    url?: string | undefined;
    number?: number | undefined;
    baseBranch?: string | undefined;
    headBranch?: string | undefined;
    title?: string | undefined;
  };
}): VcsRunActionResult {
  return {
    action: result.action,
    ref: {
      status: result.branch.status,
      ...(result.branch.name ? { name: result.branch.name, kind: "branch" as const } : {}),
    },
    commit: {
      status: result.commit.status,
      ...(result.commit.commitSha ? { commitId: result.commit.commitSha } : {}),
      ...(result.commit.subject ? { subject: result.commit.subject } : {}),
    },
    push: {
      status: result.push.status,
      ...(result.push.branch ? { refName: result.push.branch } : {}),
      ...(result.push.upstreamBranch ? { upstreamRefName: result.push.upstreamBranch } : {}),
      ...(result.push.setUpstream !== undefined ? { setUpstream: result.push.setUpstream } : {}),
    },
    pr: {
      status: result.pr.status,
      ...(result.pr.url ? { url: result.pr.url } : {}),
      ...(result.pr.number ? { number: result.pr.number } : {}),
      ...(result.pr.baseBranch ? { baseRef: result.pr.baseBranch } : {}),
      ...(result.pr.headBranch ? { headRef: result.pr.headBranch } : {}),
      ...(result.pr.title ? { title: result.pr.title } : {}),
    },
  };
}

const makeVcsManager = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;
  const vcsCore = yield* VcsCore;
  const vcsResolver = yield* VcsResolver;
  const vcsProcess = yield* VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

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

  const prepareJjCommitContext = (cwd: string) =>
    Effect.gen(function* () {
      const [summary, patch] = yield* Effect.all(
        [
          runJj(cwd, ["diff", "--summary"], "VcsManager.prepareJjCommitContext.summary"),
          runJj(cwd, ["diff"], "VcsManager.prepareJjCommitContext.patch"),
        ],
        { concurrency: "unbounded" },
      );
      const stagedSummary = summary.stdout.trim();
      const stagedPatch = patch.stdout.trim();
      if (stagedSummary.length === 0 && stagedPatch.length === 0) {
        return null;
      }
      return { stagedSummary, stagedPatch };
    });

  const resolveJjCommitSuggestion = (input: {
    cwd: string;
    refName: string | null;
    commitMessage?: string | undefined;
    includeRefName?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
          ...(input.includeRefName
            ? { refName: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
        } satisfies CommitSuggestion;
      }

      const context = yield* prepareJjCommitContext(input.cwd);
      if (!context) {
        return null;
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.refName,
          stagedSummary: context.stagedSummary,
          stagedPatch: context.stagedPatch,
          ...(input.includeRefName ? { includeBranch: true } : {}),
        })
        .pipe(
          Effect.map((result) =>
            sanitizeCommitSuggestion({
              subject: result.subject,
              body: result.body,
              ...(result.branch ? { branch: result.branch } : {}),
            }),
          ),
          Effect.mapError((error) =>
            vcsCommandError(
              "VcsManager.resolveJjCommitSuggestion",
              input.cwd,
              "textGeneration.generateCommitMessage",
              error instanceof Error ? error.message : "Failed to generate commit message.",
              error,
            ),
          ),
        );
      return generated;
    });

  const resolveJjFeatureRefName = (cwd: string, preferredRefName?: string) =>
    Effect.gen(function* () {
      const bookmarkRows = yield* listJjBookmarks(runJj, cwd, "VcsManager.listJjBookmarks");
      const existingLocalBookmarks = bookmarkRows
        .filter((row) => !row.remote)
        .map((row) => row.name?.trim() ?? "")
        .filter((name) => name.length > 0);
      return resolveAutoFeatureBranchName(existingLocalBookmarks, preferredRefName);
    });

  const readJjCommittedChangeId = (cwd: string) =>
    runJj(
      cwd,
      ["log", "-r", "@-", "--no-graph", "-T", 'commit_id ++ "\\n"'],
      "VcsManager.readJjCommittedChangeId",
    ).pipe(Effect.map((result) => result.stdout.trim()));

  const readJjRangeContext = (cwd: string, baseRef: string, headRef: string) =>
    Effect.gen(function* () {
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runJj(
            cwd,
            ["log", "-r", `${baseRef}..${headRef}`, "--no-graph", "-T", 'commit_id.short(8) ++ " " ++ description.first_line() ++ "\\n"'],
            "VcsManager.readJjRangeContext.log",
          ),
          runJj(
            cwd,
            ["diff", "--from", baseRef, "--to", headRef, "--summary"],
            "VcsManager.readJjRangeContext.summary",
          ),
          runJj(cwd, ["diff", "--from", baseRef, "--to", headRef], "VcsManager.readJjRangeContext.patch"),
        ],
        { concurrency: "unbounded" },
      );
      return {
        commitSummary: commitSummary.stdout.trim(),
        diffSummary: diffSummary.stdout.trim(),
        diffPatch: diffPatch.stdout.trim(),
      };
    });

  const findLatestJjPr = (cwd: string, bookmarkName: string) =>
    Effect.gen(function* () {
      const result = yield* gitHubCli
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
          Effect.mapError((error) =>
            vcsCommandError(
              "VcsManager.findLatestJjPr",
              cwd,
              "gh pr list",
              error instanceof Error ? error.message : "Failed to list pull requests.",
              error,
            ),
          ),
        );
      const trimmed = result.stdout.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const parsed = parsePullRequestList(JSON.parse(trimmed) as unknown).toSorted((left, right) => {
        const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
        const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
        return rightUpdated - leftUpdated;
      });
      return parsed.find((entry) => entry.state === "open") ?? parsed[0] ?? null;
    });

  const status: VcsManagerShape["status"] = vcsCore.status;

  const pull: VcsManagerShape["pull"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* vcsResolver.resolve(input);
      if (resolution.backend === "git") {
        const result = yield* gitCore.pullCurrentBranch(input.cwd).pipe(
          Effect.mapError((error) =>
            vcsCommandError(
              "VcsManager.pull",
              input.cwd,
              "git pull --ff-only",
              error.message,
              error,
            ),
          ),
        );
        return {
          status: result.status,
          refName: result.branch,
          upstreamRefName: result.upstreamBranch,
        };
      }

      const currentStatus = yield* vcsCore.status(input);
      const bookmarkName = currentStatus.refName;
      if (!bookmarkName) {
        return yield* new VcsUnsupportedError({
          operation: "VcsManager.pull",
          cwd: input.cwd,
          detail: "Select a single jj bookmark attached to the current workspace before pulling.",
        });
      }
      const remote = yield* resolveJjPushRemote(runJj, input.cwd, {
        config: "VcsManager.resolveJjPushRemote.config",
        remotes: "VcsManager.resolveJjPushRemote.remotes",
      });
      if (!remote || !currentStatus.hasUpstream || currentStatus.behindCount === 0) {
        return {
          status: "skipped_up_to_date" as const,
          refName: bookmarkName,
          upstreamRefName: remote ? `${bookmarkName}@${remote.name}` : null,
        };
      }

      yield* runJj(
        input.cwd,
        ["git", "fetch", "--remote", remote.name],
        "VcsManager.pull.jjFetch",
      ).pipe(
        Effect.mapError((error) =>
          vcsCommandError(
            "VcsManager.pull",
            input.cwd,
            "jj git fetch",
            error instanceof Error ? error.message : "Failed to fetch bookmark updates.",
            error,
          ),
        ),
      );
      yield* runJj(
        input.cwd,
        ["rebase", "-b", "@", "-d", bookmarkName],
        "VcsManager.pull.jjRebase",
      ).pipe(
        Effect.mapError((error) =>
          vcsCommandError(
            "VcsManager.pull",
            input.cwd,
            "jj rebase -b @ -d",
            error instanceof Error ? error.message : "Failed to rebase onto updated bookmark.",
            error,
          ),
        ),
      );

      return {
        status: "pulled" as const,
        refName: bookmarkName,
        upstreamRefName: `${bookmarkName}@${remote.name}`,
      };
    });

  const runAction: VcsManagerShape["runAction"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* vcsResolver.resolve(input);
      if (resolution.backend === "git") {
        const result = yield* gitManager
          .runStackedAction({
            cwd: input.cwd,
            action: input.action,
            ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
            ...(input.createFeatureRef ? { featureBranch: input.createFeatureRef } : {}),
          })
          .pipe(
            Effect.mapError((error) =>
              vcsCommandError(
                "VcsManager.runAction",
                input.cwd,
                "git.runStackedAction",
                error.message,
                error,
              ),
            ),
          );
        return toVcsRunActionResult(result);
      }

      const initialStatus = yield* vcsCore.status(input);
      const wantsPush = input.action !== "commit";
      const wantsPr = input.action === "commit_push_pr";
      const includesCommit = input.action === "commit" || initialStatus.hasWorkingTreeChanges;
      const remote = yield* resolveJjPushRemote(runJj, input.cwd, {
        config: "VcsManager.resolveJjPushRemote.config",
        remotes: "VcsManager.resolveJjPushRemote.remotes",
      });

      if (wantsPr) {
        if (!remote || !isGitHubRemoteUrl(remote.url)) {
          return yield* new VcsUnsupportedError({
            operation: "VcsManager.runAction",
            cwd: input.cwd,
            detail: "Pull request creation is only supported for jj repositories backed by GitHub remotes.",
          });
        }
      }

      let actionBookmark = initialStatus.refName;
      let resolvedCommitMessage = input.commitMessage;
      let refStep: VcsRunActionResult["ref"] = { status: "skipped_not_requested" };

      if (input.createFeatureRef) {
        const suggestion = yield* resolveJjCommitSuggestion({
          cwd: input.cwd,
          refName: initialStatus.refName,
          ...(resolvedCommitMessage ? { commitMessage: resolvedCommitMessage } : {}),
          includeRefName: true,
        });
        const preferredRefName = suggestion?.refName;
        const nextBookmarkName = yield* resolveJjFeatureRefName(input.cwd, preferredRefName);
        yield* runJj(
          input.cwd,
          ["bookmark", "create", "--revision", "@", nextBookmarkName],
          "VcsManager.runAction.createFeatureBookmark",
        ).pipe(
          Effect.mapError((error) =>
            vcsCommandError(
              "VcsManager.runAction",
              input.cwd,
              "jj bookmark create",
              error instanceof Error ? error.message : "Failed to create jj bookmark.",
              error,
            ),
          ),
        );
        actionBookmark = nextBookmarkName;
        refStep = {
          status: "created",
          name: nextBookmarkName,
          kind: "bookmark",
        };
        if (suggestion?.commitMessage) {
          resolvedCommitMessage = suggestion.commitMessage;
        }
      }

      if (!actionBookmark) {
        return yield* new VcsUnsupportedError({
          operation: "VcsManager.runAction",
          cwd: input.cwd,
          detail: "Select a single jj bookmark attached to the current workspace before running actions.",
        });
      }

      let commit: VcsRunActionResult["commit"] = { status: "skipped_no_changes" };
      if (includesCommit) {
        if (!input.createFeatureRef) {
          yield* runJj(
            input.cwd,
            ["bookmark", "move", actionBookmark, "--to", "@"],
            "VcsManager.runAction.moveBookmarkToWorkingCopy",
          ).pipe(
            Effect.mapError((error) =>
              vcsCommandError(
                "VcsManager.runAction",
                input.cwd,
                "jj bookmark move",
                error instanceof Error ? error.message : "Failed to move jj bookmark onto the working copy.",
                error,
              ),
            ),
          );
        }

        const suggestion = yield* resolveJjCommitSuggestion({
          cwd: input.cwd,
          refName: actionBookmark,
          ...(resolvedCommitMessage ? { commitMessage: resolvedCommitMessage } : {}),
        });
        if (suggestion) {
          yield* runJj(
            input.cwd,
            ["commit", "-m", suggestion.commitMessage],
            "VcsManager.runAction.commit",
          ).pipe(
            Effect.mapError((error) =>
              vcsCommandError(
                "VcsManager.runAction",
                input.cwd,
                "jj commit",
                error instanceof Error ? error.message : "Failed to create jj commit.",
                error,
              ),
            ),
          );
          const commitId = yield* readJjCommittedChangeId(input.cwd).pipe(
            Effect.catch(() => Effect.succeed("")),
          );
          commit = {
            status: "created",
            ...(commitId ? { commitId } : {}),
            subject: suggestion.subject,
          };
        }
      }

      const postCommitStatus = yield* vcsCore.status({
        cwd: input.cwd,
        backend: "jj",
        contextRefName: actionBookmark,
        contextRefKind: "bookmark",
      });

      let push: VcsRunActionResult["push"] = { status: "skipped_not_requested" };
      if (wantsPush) {
        if (!remote) {
          return yield* new VcsUnsupportedError({
            operation: "VcsManager.runAction",
            cwd: input.cwd,
            detail: "No jj push remote could be resolved for this repository.",
          });
        }
        if (postCommitStatus.aheadCount === 0) {
          push = {
            status: "skipped_up_to_date",
            refName: actionBookmark,
            ...(postCommitStatus.hasUpstream ? { upstreamRefName: `${actionBookmark}@${remote.name}` } : {}),
          };
        } else {
          const pushArgs = [
            "git",
            "push",
            "--remote",
            remote.name,
            "--bookmark",
            actionBookmark,
            ...(!postCommitStatus.hasUpstream ? ["--allow-new"] : []),
          ];
          yield* runJj(input.cwd, pushArgs, "VcsManager.runAction.push").pipe(
            Effect.mapError((error) =>
              vcsCommandError(
                "VcsManager.runAction",
                input.cwd,
                "jj git push",
                error instanceof Error ? error.message : "Failed to push jj bookmark.",
                error,
              ),
            ),
          );
          push = {
            status: "pushed",
            refName: actionBookmark,
            upstreamRefName: `${actionBookmark}@${remote.name}`,
            ...(postCommitStatus.hasUpstream ? {} : { setUpstream: true }),
          };
        }
      }

      let pr: VcsRunActionResult["pr"] = { status: "skipped_not_requested" };
      if (wantsPr) {
        if (!remote || !isGitHubRemoteUrl(remote.url)) {
          return yield* new VcsUnsupportedError({
            operation: "VcsManager.runAction",
            cwd: input.cwd,
            detail: "Pull request creation is only supported for GitHub-backed jj repositories.",
          });
        }
        const existing = yield* findLatestJjPr(input.cwd, actionBookmark).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (existing?.state === "open") {
          pr = {
            status: "opened_existing",
            url: existing.url,
            number: existing.number,
            baseRef: existing.baseRefName,
            headRef: existing.headRefName,
            title: existing.title,
          };
        } else {
          const nearestAncestorRemoteBookmarkNames = yield* readNearestAncestorRemoteBookmarkNames(
            runJj,
            {
              cwd: input.cwd,
              revision: `${actionBookmark}-`,
              remoteName: remote.name,
              operation: "VcsManager.readNearestAncestorRemoteBookmarkNames",
            },
          ).pipe(Effect.catch(() => Effect.succeed([])));
          const baseRef =
            nearestAncestorRemoteBookmarkNames[0] ??
            (yield* gitHubCli.getDefaultBranch({ cwd: input.cwd }).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )) ??
            "main";
          const rangeContext = yield* readJjRangeContext(input.cwd, baseRef, actionBookmark);
          const generated = yield* textGeneration.generatePrContent({
            cwd: input.cwd,
            baseBranch: baseRef,
            headBranch: actionBookmark,
            commitSummary: rangeContext.commitSummary,
            diffSummary: rangeContext.diffSummary,
            diffPatch: rangeContext.diffPatch,
          }).pipe(
            Effect.mapError((error) =>
              vcsCommandError(
                "VcsManager.runAction",
                input.cwd,
                "textGeneration.generatePrContent",
                error instanceof Error ? error.message : "Failed to generate pull request content.",
                error,
              ),
            ),
          );

          const bodyFile = path.join(tempDir, `t3code-jj-pr-body-${process.pid}-${randomUUID()}.md`);
          yield* fileSystem.writeFileString(bodyFile, generated.body).pipe(
            Effect.mapError((error) =>
              vcsCommandError(
                "VcsManager.runAction",
                input.cwd,
                "writeFile",
                error instanceof Error ? error.message : "Failed to write pull request body file.",
                error,
              ),
            ),
          );

          yield* gitHubCli
            .createPullRequest({
              cwd: input.cwd,
              baseBranch: baseRef,
              headBranch: actionBookmark,
              title: generated.title,
              bodyFile,
            })
            .pipe(
              Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))),
              Effect.mapError((error) =>
                vcsCommandError(
                  "VcsManager.runAction",
                  input.cwd,
                  "gh pr create",
                  error instanceof Error ? error.message : "Failed to create pull request.",
                  error,
                ),
              ),
            );

          const created = yield* findLatestJjPr(input.cwd, actionBookmark).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          pr = {
            status: "created",
            ...(created?.url ? { url: created.url } : {}),
            ...(created?.number ? { number: created.number } : {}),
            baseRef,
            headRef: actionBookmark,
            title: created?.title ?? generated.title,
          };
        }
      }

      return {
        action: input.action,
        ref: refStep,
        commit,
        push,
        pr,
      } satisfies VcsRunActionResult;
    });

  return {
    status,
    pull,
    runAction,
    listRefs: vcsCore.listRefs,
    createWorkspace: vcsCore.createWorkspace,
    removeWorkspace: vcsCore.removeWorkspace,
    createRef: vcsCore.createRef,
    checkoutRef: vcsCore.checkoutRef,
    init: vcsCore.init,
  } satisfies VcsManagerShape;
});

export const VcsManagerLive = Layer.effect(VcsManager, makeVcsManager);
