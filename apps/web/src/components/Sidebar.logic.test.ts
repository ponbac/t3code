import { describe, expect, it } from "vitest";

import {
  hasUnseenCompletion,
  resolveThreadPrByThreadId,
  resolveThreadPrQueryTargets,
  resolveThreadPrTargets,
  resolveThreadStatusPill,
} from "./Sidebar.logic";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        proposedPlans: [],
        session: null,
      }),
    ).toBe(true);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadPrTargets", () => {
  it("uses each thread's stored VCS ref context instead of the repo's current branch", () => {
    const projectId = "project-1" as never;
    const threadId = "thread-1" as never;
    const targets = resolveThreadPrTargets(
      [
        {
          id: threadId,
          projectId,
          vcsBackend: "git",
          refName: "feature/pr-branch",
          refKind: "branch",
          branch: "feature/pr-branch",
          workspacePath: null,
          worktreePath: null,
        },
      ],
      new Map([[projectId, "/repo"]]),
    );

    expect(targets).toEqual([
      {
        threadId,
        cwd: "/repo",
        refName: "feature/pr-branch",
        refKind: "branch",
      },
    ]);
  });

  it("dedupes PR status queries by cwd and ref context", () => {
    const targets = resolveThreadPrQueryTargets([
      {
        threadId: "thread-1" as never,
        cwd: "/repo",
        refName: "feature/a",
        refKind: "branch",
      },
      {
        threadId: "thread-2" as never,
        cwd: "/repo",
        refName: "feature/a",
        refKind: "branch",
      },
      {
        threadId: "thread-3" as never,
        cwd: "/repo",
        refName: "feature/b",
        refKind: "branch",
      },
    ]);

    expect(targets).toHaveLength(2);
    expect(targets.map((target) => target.refName)).toEqual(["feature/a", "feature/b"]);
  });

  it("maps PR state back to a thread even if the live repo HEAD is elsewhere", () => {
    const threadTargets = [
      {
        threadId: "thread-1" as never,
        cwd: "/repo",
        refName: "feature/a",
        refKind: "branch" as const,
      },
    ];
    const queryTargets = resolveThreadPrQueryTargets(threadTargets);
    const prByThreadId = resolveThreadPrByThreadId(
      threadTargets,
      new Map([
        [
          queryTargets[0]!.key,
          {
            branch: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: true,
            aheadCount: 1,
            behindCount: 0,
            pr: {
              number: 42,
              title: "Ship sidebar PR badge",
              url: "https://example.com/pr/42",
              baseBranch: "main",
              headBranch: "feature/a",
              state: "open",
            },
          },
        ],
      ]),
    );

    expect(prByThreadId.get("thread-1" as never)).toMatchObject({
      number: 42,
      state: "open",
      headBranch: "feature/a",
    });
  });

  it("falls back to the live repo PR state when a thread has no stored ref metadata", () => {
    const threadTargets = [
      {
        threadId: "thread-1" as never,
        cwd: "/repo",
        refName: null,
        refKind: null,
      },
    ];
    const queryTargets = resolveThreadPrQueryTargets(threadTargets);
    const prByThreadId = resolveThreadPrByThreadId(
      threadTargets,
      new Map([
        [
          queryTargets[0]!.key,
          {
            branch: "feature/current",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: true,
            aheadCount: 1,
            behindCount: 0,
            pr: {
              number: 7,
              title: "Current project PR",
              url: "https://example.com/pr/7",
              baseBranch: "main",
              headBranch: "feature/current",
              state: "open",
            },
          },
        ],
      ]),
    );

    expect(queryTargets).toEqual([
      {
        key: "/repo\u0000\u0000",
        cwd: "/repo",
        refName: null,
        refKind: null,
      },
    ]);
    expect(prByThreadId.get("thread-1" as never)).toMatchObject({
      number: 7,
      state: "open",
      headBranch: "feature/current",
    });
  });
});
