import type {
  VcsAction,
  VcsRefKind,
  VcsStatusInput,
  VcsStatusResult,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (input: { cwd: string | null; contextRefName?: string | null; contextRefKind?: VcsRefKind | null }) =>
    ["git", "status", input.cwd, input.contextRefName ?? null, input.contextRefKind ?? null] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  runStackedAction: (input: {
    cwd: string | null;
    contextRefName?: string | null;
    contextRefKind?: VcsRefKind | null;
  }) =>
    [
      "git",
      "mutation",
      "run-stacked-action",
      input.cwd,
      input.contextRefName ?? null,
      input.contextRefKind ?? null,
    ] as const,
  pull: (input: {
    cwd: string | null;
    contextRefName?: string | null;
    contextRefKind?: VcsRefKind | null;
  }) =>
    ["git", "mutation", "pull", input.cwd, input.contextRefName ?? null, input.contextRefKind ?? null] as const,
};

export function invalidateGitQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function gitStatusQueryOptions(input: {
  cwd: string | null;
  contextRefName?: string | null;
  contextRefKind?: VcsRefKind | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.status(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("VCS status is unavailable.");
      const request: VcsStatusInput = {
        cwd: input.cwd,
        ...(input.contextRefName ? { contextRefName: input.contextRefName } : {}),
        ...(input.contextRefKind ? { contextRefKind: input.contextRefKind } : {}),
      };
      const result = await api.vcs.status(request);
      return {
        ...result,
        branch: result.refName,
        pr: result.pr
          ? {
              ...result.pr,
              baseBranch: result.pr.baseRef,
              headBranch: result.pr.headRef,
            }
          : null,
      };
    },
    enabled: input.cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitBranchesQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.branches(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("VCS refs are unavailable.");
      const result = await api.vcs.listRefs({ cwd });
      return {
        ...result,
        branches: result.refs,
      };
    },
    enabled: cwd !== null,
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("VCS init is unavailable.");
      return api.vcs.init({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("VCS checkout is unavailable.");
      return api.vcs.checkoutRef({ cwd: input.cwd, refName: branch, refKind: "branch" });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
  gitStatus?: VcsStatusResult | null;
  contextRefName?: string | null;
  contextRefKind?: VcsRefKind | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input),
    mutationFn: async ({
      action,
      commitMessage,
      createFeatureRef,
    }: {
      action: VcsAction;
      commitMessage?: string;
      createFeatureRef?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git action is unavailable.");
      if (
        !input.gitStatus?.capabilities.supportsCommit &&
        !input.gitStatus?.capabilities.supportsPush &&
        !input.gitStatus?.capabilities.supportsCreatePullRequest
      ) {
        throw new Error("Git actions are unavailable for this repository backend.");
      }
      return api.vcs.runAction({
        cwd: input.cwd,
        action,
        ...(input.contextRefName ? { contextRefName: input.contextRefName } : {}),
        ...(input.contextRefKind ? { contextRefKind: input.contextRefKind } : {}),
        ...(commitMessage ? { commitMessage } : {}),
        ...(createFeatureRef ? { createFeatureRef } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
  contextRefName?: string | null;
  contextRefKind?: VcsRefKind | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.vcs.pull({
        cwd: input.cwd,
        ...(input.contextRefName ? { contextRefName: input.contextRefName } : {}),
        ...(input.contextRefKind ? { contextRefKind: input.contextRefKind } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      refKind,
      newBranch,
      path,
    }: {
      cwd: string;
      branch: string;
      refKind?: VcsRefKind;
      newBranch?: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Workspace creation is unavailable.");
      const result = await api.vcs.createWorkspace({
        cwd,
        refName: branch,
        refKind: refKind ?? "branch",
        ...(newBranch ? { newRefName: newBranch } : {}),
        path: path ?? null,
      });
      return {
        ...result,
        worktree: {
          path: result.workspace.path,
          branch: result.workspace.refName,
        },
      };
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path, force }: { cwd: string; path: string; force?: boolean }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Workspace removal is unavailable.");
      return api.vcs.removeWorkspace({ cwd, path, force });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
