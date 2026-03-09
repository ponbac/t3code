import type { VcsBackend } from "@t3tools/contracts";

export interface WorkspaceLabels {
  readonly item: "worktree" | "workspace";
  readonly itemTitle: "Worktree" | "Workspace";
  readonly preparing: "Preparing worktree" | "Preparing workspace";
  readonly newItemTitle: "New worktree" | "New workspace";
}

export function getWorkspaceLabels(backend: VcsBackend): WorkspaceLabels {
  if (backend === "jj") {
    return {
      item: "workspace",
      itemTitle: "Workspace",
      preparing: "Preparing workspace",
      newItemTitle: "New workspace",
    };
  }
  return {
    item: "worktree",
    itemTitle: "Worktree",
    preparing: "Preparing worktree",
    newItemTitle: "New worktree",
  };
}
