import type { GitBranch } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  canCreateBranchFromBranchToolbar,
  countCurrentLocalBranches,
  filterBranchToolbarBranches,
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  hasAmbiguousJjRootLocalState,
  isSelectingWorktreeBaseForBranchToolbar,
  resolveCurrentBranchForToolbar,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveBranchToolbarValue,
  shouldSelectBranchWithoutCheckout,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base branch before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a branch already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git branch when no explicit base branch is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base branch", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out branch when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: GitBranch[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: GitBranch[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected branch", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the branch already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default branch in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default branches", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("resolveCurrentBranchForToolbar", () => {
  it("returns null for ambiguous JJ root state without an explicit status branch", () => {
    expect(
      resolveCurrentBranchForToolbar({
        backend: "jj",
        statusBranch: null,
        branches: [
          {
            name: "alpha",
            current: true,
            isDefault: false,
            worktreePath: null,
          },
          {
            name: "beta",
            current: true,
            isDefault: false,
            worktreePath: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it("prefers the status branch for JJ workspaces", () => {
    expect(
      resolveCurrentBranchForToolbar({
        backend: "jj",
        statusBranch: "beta",
        branches: [
          {
            name: "alpha",
            current: true,
            isDefault: false,
            worktreePath: null,
          },
          {
            name: "beta",
            current: true,
            isDefault: false,
            worktreePath: "/repo/.t3/worktrees/beta",
          },
        ],
      }),
    ).toBe("beta");
  });
});

describe("JJ branch toolbar helpers", () => {
  const jjBranches: GitBranch[] = [
    {
      name: "alpha",
      current: true,
      isDefault: false,
      worktreePath: null,
    },
    {
      name: "beta",
      current: true,
      isDefault: false,
      worktreePath: null,
    },
    {
      name: "gamma",
      current: false,
      isDefault: false,
      worktreePath: null,
    },
    {
      name: "delta",
      current: false,
      isDefault: false,
      worktreePath: "/repo/.t3/worktrees/delta",
    },
    {
      name: "origin/main",
      isRemote: true,
      remoteName: "origin",
      current: false,
      isDefault: true,
      worktreePath: null,
    },
  ];

  it("shows only current local bookmarks and managed workspaces in JJ root local mode", () => {
    expect(
      filterBranchToolbarBranches({
        backend: "jj",
        branches: jjBranches,
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        envLocked: false,
      }).map((branch) => branch.name),
    ).toEqual(["alpha", "beta", "delta"]);
  });

  it("keeps remote JJ bookmarks visible when selecting a new worktree base", () => {
    expect(
      isSelectingWorktreeBaseForBranchToolbar({
        effectiveEnvMode: "worktree",
        activeWorktreePath: null,
        envLocked: false,
      }),
    ).toBe(true);
    expect(
      filterBranchToolbarBranches({
        backend: "jj",
        branches: jjBranches,
        effectiveEnvMode: "worktree",
        activeWorktreePath: null,
        envLocked: false,
      }).map((branch) => branch.name),
    ).toEqual(["alpha", "beta", "gamma", "delta", "origin/main"]);
  });

  it("hides create-branch in JJ root-local and base-selection modes", () => {
    expect(
      canCreateBranchFromBranchToolbar({
        backend: "jj",
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        envLocked: false,
      }),
    ).toBe(false);
    expect(
      canCreateBranchFromBranchToolbar({
        backend: "jj",
        effectiveEnvMode: "worktree",
        activeWorktreePath: null,
        envLocked: false,
      }),
    ).toBe(false);
  });

  it("allows create-branch inside an explicit JJ workspace", () => {
    expect(
      canCreateBranchFromBranchToolbar({
        backend: "jj",
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/beta",
        envLocked: false,
      }),
    ).toBe(true);
  });

  it("treats JJ root-local current bookmark selection as metadata-only", () => {
    expect(
      shouldSelectBranchWithoutCheckout({
        backend: "jj",
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        branch: {
          current: true,
          isRemote: false,
          worktreePath: null,
        },
      }),
    ).toBe(true);
    expect(countCurrentLocalBranches(jjBranches)).toBe(2);
  });

  it("detects ambiguous JJ root-local state from shared helper logic", () => {
    expect(
      hasAmbiguousJjRootLocalState({
        backend: "jj",
        activeWorktreePath: null,
        branches: jjBranches,
      }),
    ).toBe(true);
    expect(
      hasAmbiguousJjRootLocalState({
        backend: "jj",
        activeWorktreePath: "/repo/.t3/worktrees/beta",
        branches: jjBranches,
      }),
    ).toBe(false);
  });
});
