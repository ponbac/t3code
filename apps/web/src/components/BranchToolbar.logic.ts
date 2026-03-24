import type { GitBackend, GitBranch } from "@t3tools/contracts";
import { Schema } from "effect";

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  return activeWorktreePath || (!hasServerThread && draftThreadEnvMode === "worktree")
    ? "worktree"
    : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveCurrentBranchForToolbar(input: {
  backend: GitBackend | null;
  statusBranch: string | null;
  branches: ReadonlyArray<GitBranch>;
}): string | null {
  const { backend, statusBranch, branches } = input;
  if (statusBranch) {
    return statusBranch;
  }

  if (backend === "jj") {
    const currentLocalBranches = branches.filter((branch) => branch.current && !branch.isRemote);
    return currentLocalBranches.length === 1 ? (currentLocalBranches[0]?.name ?? null) : null;
  }

  return branches.find((branch) => branch.current)?.name ?? null;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    if (branch.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function isSelectingWorktreeBaseForBranchToolbar(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  envLocked: boolean;
}): boolean {
  return input.effectiveEnvMode === "worktree" && !input.envLocked && !input.activeWorktreePath;
}

export function hasAmbiguousJjRootLocalState(input: {
  backend: GitBackend | null;
  activeWorktreePath: string | null;
  branches: ReadonlyArray<GitBranch>;
}): boolean {
  return (
    input.backend === "jj" &&
    input.activeWorktreePath === null &&
    countCurrentLocalBranches(input.branches) > 1
  );
}

export function filterBranchToolbarBranches(input: {
  backend: GitBackend | null;
  branches: ReadonlyArray<GitBranch>;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  envLocked: boolean;
}): ReadonlyArray<GitBranch> {
  if (input.backend !== "jj") {
    return dedupeRemoteBranchesWithLocalMatches(input.branches);
  }

  if (
    input.activeWorktreePath !== null ||
    isSelectingWorktreeBaseForBranchToolbar({
      effectiveEnvMode: input.effectiveEnvMode,
      activeWorktreePath: input.activeWorktreePath,
      envLocked: input.envLocked,
    })
  ) {
    return input.branches;
  }

  return input.branches.filter(
    (branch) => branch.worktreePath !== null || (branch.current && !branch.isRemote),
  );
}

export function canCreateBranchFromBranchToolbar(input: {
  backend: GitBackend | null;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  envLocked: boolean;
}): boolean {
  if (
    isSelectingWorktreeBaseForBranchToolbar({
      effectiveEnvMode: input.effectiveEnvMode,
      activeWorktreePath: input.activeWorktreePath,
      envLocked: input.envLocked,
    })
  ) {
    return false;
  }

  if (input.backend === "jj" && input.activeWorktreePath === null) {
    return false;
  }

  return true;
}

export function shouldSelectBranchWithoutCheckout(input: {
  backend: GitBackend | null;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  branch: Pick<GitBranch, "current" | "isRemote" | "worktreePath">;
}): boolean {
  return (
    input.backend === "jj" &&
    input.effectiveEnvMode === "local" &&
    input.activeWorktreePath === null &&
    input.branch.worktreePath === null &&
    input.branch.current &&
    !input.branch.isRemote
  );
}

export function countCurrentLocalBranches(branches: ReadonlyArray<GitBranch>): number {
  return branches.filter((branch) => branch.current && !branch.isRemote).length;
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  branch: Pick<GitBranch, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, branch } = input;

  if (branch.worktreePath) {
    return {
      checkoutCwd: branch.worktreePath,
      nextWorktreePath: branch.worktreePath === activeProjectCwd ? null : branch.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && branch.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}
