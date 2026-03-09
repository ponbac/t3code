import type { GitStatusResult, ProjectId } from "@t3tools/contracts";
import type { Thread } from "../types";
import { findLatestProposedPlan, isLatestTurnSettled } from "../session-logic";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

export interface ThreadPrTarget {
  threadId: Thread["id"];
  cwd: string | null;
  refName: string | null;
  refKind: Thread["refKind"];
}

export interface ThreadPrQueryTarget {
  key: string;
  cwd: string;
  refName: string | null;
  refKind: Thread["refKind"];
}

function resolveThreadRefKind(thread: Pick<Thread, "vcsBackend" | "refKind" | "refName" | "branch">) {
  if (thread.refKind) {
    return thread.refKind;
  }

  const refName = thread.refName ?? thread.branch;
  if (!refName) {
    return null;
  }

  return thread.vcsBackend === "jj" ? "bookmark" : "branch";
}

function makeThreadPrQueryKey(input: {
  cwd: string;
  refName: string | null;
  refKind: Thread["refKind"];
}) {
  return `${input.cwd}\u0000${input.refName ?? ""}\u0000${input.refKind ?? ""}`;
}

export function resolveThreadPrTargets(
  threads: ReadonlyArray<
    Pick<
      Thread,
      "id" | "projectId" | "vcsBackend" | "refName" | "refKind" | "branch" | "workspacePath" | "worktreePath"
    >
  >,
  projectCwdById: ReadonlyMap<ProjectId, string>,
): Array<ThreadPrTarget> {
  return threads.map((thread) => ({
    threadId: thread.id,
    cwd: thread.workspacePath ?? thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
    refName: thread.refName ?? thread.branch ?? null,
    refKind: resolveThreadRefKind(thread),
  }));
}

export function resolveThreadPrQueryTargets(
  threadTargets: ReadonlyArray<ThreadPrTarget>,
): Array<ThreadPrQueryTarget> {
  const seen = new Set<string>();
  const output: Array<ThreadPrQueryTarget> = [];

  for (const target of threadTargets) {
    if (!target.cwd) {
      continue;
    }

    const key = makeThreadPrQueryKey({
      cwd: target.cwd,
      refName: target.refName,
      refKind: target.refKind,
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({
      key,
      cwd: target.cwd,
      refName: target.refName,
      refKind: target.refKind,
    });
  }

  return output;
}

export function resolveThreadPrByThreadId(
  threadTargets: ReadonlyArray<ThreadPrTarget>,
  statusByQueryKey: ReadonlyMap<string, GitStatusResult>,
): Map<Thread["id"], GitStatusResult["pr"]> {
  const output = new Map<Thread["id"], GitStatusResult["pr"]>();

  for (const target of threadTargets) {
    if (!target.cwd) {
      output.set(target.threadId, null);
      continue;
    }

    const key = makeThreadPrQueryKey({
      cwd: target.cwd,
      refName: target.refName,
      refKind: target.refKind,
    });
    output.set(target.threadId, statusByQueryKey.get(key)?.pr ?? null);
  }

  return output;
}

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session"
>;

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null) !== null;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}
