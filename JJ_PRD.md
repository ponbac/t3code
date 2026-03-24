# JJ Support PRD

## Document Purpose

- This is the working PRD for JJ support.
- It is the source of truth during implementation.
- Update this file as implementation progresses. Do not leave status, verification, or scope drift only in chat history.
- Put implementation discoveries, command gotchas, and repo-specific pitfalls in `JJ_LEARNINGS.md`.
- Use `JJ_PROMPT.md` to resume work in a later session.

## Current Status

- Status: In Progress
- Owner: Unassigned
- Last updated: 2026-03-11
- Companion docs: `JJ_LEARNINGS.md`, `JJ_PROMPT.md`

## Product Summary

- Add JJ support without introducing a generic `vcs.*` surface.
- Keep the public `git.*` / `api.git.*` model and existing thread metadata (`branch`, `worktreePath`) intact.
- Make JJ support workspace-first so behavior stays predictable under multi-bookmark and reconnect/restart scenarios.
- Support only git-backed JJ repos and app-managed JJ workspaces in this pass.

## Goals

- Auto-detect git vs JJ from the active cwd.
- Preserve current git behavior.
- Support JJ status, branch selection, workspace creation/removal, stacked actions, and PR thread preparation.
- Make raw `git` and `gh` plumbing work correctly from JJ workspaces.
- Keep checkpointing, runtime ingestion, and workspace search safe in JJ workspaces.

## Non-Goals

- No `vcs.*` API or generic VCS algebra.
- No thread schema migration or persisted backend field.
- No JJ init flow in this pass.
- No discovery or removal of arbitrary user-created JJ workspaces.
- No full terminology split across the UI.

## User-Facing Requirements

- Git users must see no behavior regressions.
- JJ repos must be selected automatically from cwd.
- JJ root local mode must avoid ambiguous bookmark mutations.
- JJ new-worktree mode must create a dedicated workspace from an explicit bookmark base.
- PR thread preparation must work in both current-repo and dedicated-workspace modes.

## Validation Strategy

- Keep automated tests light. Add tests only for the most critical functionality and the highest-risk regressions.
- Prefer focused unit and integration coverage for repo detection, raw git/gh normalization, JJ branch/workspace semantics, PR preparation, and checkpoint safety.
- Do not expand snapshot-heavy or broad UI test coverage unless a regression cannot be covered more directly.
- When UI or end-to-end validation is needed, prefer validating it with the `playwriter` skill instead of adding wide automated UI coverage.
- Every implementation stopping point must include a `playwriter` validation pass against the latest exposed JJ flow, not just automated checks.
- Prefer reusing the throwaway JJ clone/workspace validation pattern from the 2026-03-10 `minioner` pass when it still matches the slice under test.
- Record the exact browser flow and outcome in the verification log, and capture any non-obvious findings in `JJ_LEARNINGS.md`.
- Any manual or browser validation that reveals a non-obvious behavior or gotcha should be recorded in `JJ_LEARNINGS.md`.
- Continue implementation work until it reaches a strong manual validation point, not just a partial code checkpoint.
- A strong manual validation point means the critical end-to-end JJ flow for the current phase is wired up enough that a user and `playwriter` can step in, exercise it, and meaningfully validate behavior.
- Do not stop at hidden plumbing changes if the resulting state is not yet testable by a user or by `playwriter`.

## Public API And Contract Changes

1. Add `GitBackend = "git" | "jj"` to `packages/contracts/src/git.ts`.
2. Add `backend: GitBackend | null` to `GitListBranchesResult`. Return `null` only when `isRepo === false`.
3. Keep all websocket method names, IPC method names, and `NativeApi` method names unchanged.
4. Do not add `contextBranch`, `refKind`, `GitBranch.kind`, or backend fields to other public result types in this pass.

## Internal Interface Changes

1. Change `GitCore.commit(cwd, subject, body)` to `GitCore.commit(cwd, subject, body, branchHint?: string | null)`.
2. Keep `GitCore.fetchPullRequestBranch(...)` in the interface as the fallback path for PR ref materialization.

## Architecture Decisions

1. Add a `RepoContextResolver` Effect service under `apps/server/src/git/Services/RepoContext.ts` and `apps/server/src/git/Layers/RepoContext.ts`.
2. `RepoContextResolver` is responsible for repo detection, normalized raw git/gh execution context, excluded top-level paths, TTL caching, and explicit invalidation.
3. Detection order is JJ first, then git. If `jj workspace root` succeeds, the backend is JJ even when `.git` is also present.
4. If JJ is detected but `jj git root` cannot be resolved, fail with an explicit unsupported-repo error.
5. `GitService`, `GitHubCli`, and workspace search must use `RepoContextResolver` so raw command execution works from JJ workspaces without Promise/Effect bridge helpers.
6. Split `GitCore` into `NativeGitCoreLive`, `JujutsuGitCoreLive`, and a delegating `GitCoreLive`.
7. Keep `GitManager` as the only high-level workflow service. Do not add a `RepositoryManager` façade.
8. Stateful server runtime plumbing with caching, invalidation, or process-environment normalization must follow the existing Effect `Services/` plus `Layers/` pattern. Do not introduce standalone helper modules for logic that owns runtime state.

## Implementation Scope

### 1. Repo Context

- Add `resolveRepoContext(cwd)` returning either `null` for non-repos or a context with `backend`, `workspaceRoot`, `gitRoot`, `gitDir`, and `excludedTopLevelNames`.
- Add a helper that merges `GIT_DIR` and `GIT_WORK_TREE` into raw process env for JJ workspaces.
- Add TTL caching for positive and negative lookups.
- Add cache invalidation hooks for `git init`, worktree/workspace creation, and worktree/workspace removal.

### 2. Raw Command Normalization

- Update `GitService` so every `git` command goes through `RepoContextResolver`.
- If repo resolution returns `null`, keep current raw cwd behavior so `git init` and non-repo probes still work.
- If repo resolution returns JJ, keep caller cwd and merge `GIT_DIR=<gitDir>` and `GIT_WORK_TREE=<workspaceRoot>` into env.
- Update `GitHubCli` to apply the same repo context before spawning `gh`.
- Update `workspaceEntries` to resolve repo context once per request and use normalized env for `git rev-parse`, `git check-ignore`, and `git ls-files`.
- Add `.jj` to the ignored-directory set in workspace search.
- Remove direct `.git` existence checks and delete `apps/server/src/git/isRepo.ts` after migration.

### 3. GitCore Split

- Move current behavior into `NativeGitCoreLive` with no intended behavior change beyond the commit signature and PR-local-flow cleanup.
- Add `JujutsuGitCoreLive` implementing the current `GitCore` interface.
- Replace `GitCoreLive` with a delegator that resolves backend and forwards to native or JJ.

### 4. JJ Backend Semantics

- `statusDetails` and `prepareCommitContext` use JJ-native working-copy diff/status commands.
- `status.branch` is the lexicographically smallest current local bookmark when multiple current local bookmarks exist. This is compatibility-only.
- `listBranches` returns local bookmarks as local branches and remote bookmarks as git-style names like `origin/feature`.
- `listBranches` marks every current local bookmark with `current: true`.
- `listBranches` sets `worktreePath` only from app-managed workspace metadata. Do not scan arbitrary JJ workspaces.
- `createBranch` creates a local bookmark at `@`.
- `checkoutBranch` supports local bookmark names and git-style remote refs like `origin/foo`.
- JJ checkout must reject dirty workspaces instead of guessing how to preserve local changes.
- Remote checkout must fetch/import the remote bookmark, materialize or reuse a local bookmark, persist upstream config, and then move the current workspace to that bookmark.
- `commit` resolves the target bookmark from `branchHint` or from the unique current local bookmark. Ambiguous targets fail explicitly.
- `pushCurrentBranch` and `pullCurrentBranch` act only on an explicit or unique local bookmark. Ambiguous root JJ state fails explicitly.
- `ensureRemote`, `readConfigValue`, and default-branch lookups reuse raw git/config plumbing against the backing git repo.
- `fetchRemoteBranch` prefers `jj git fetch --remote <name>`, then materializes or updates the matching local bookmark.
- `fetchPullRequestBranch` remains the fallback path. In JJ it fetches the PR ref into the backing git repo, runs `jj git import`, then materializes or updates the local bookmark.
- `createWorktree` reuses the existing managed-path convention under `~/.t3/worktrees/<repo>/<sanitized-name>`.
- If `createWorktree` receives `newBranch`, JJ creates that bookmark from the base ref first, then creates the workspace from the new bookmark.
- If `createWorktree` receives a remote ref like `origin/foo`, JJ first materializes a local bookmark and returns that local bookmark name in the result.
- `removeWorktree` only removes app-managed JJ workspaces.
- `renameBranch` renames the bookmark and migrates stored upstream, merge-base, and workspace-path metadata.
- `listLocalBranchNames` returns local bookmark names.
- `readRangeContext` uses JJ-native log and diff output rather than assuming git branch refs exist.

### 5. JJ Metadata Storage

- Reuse the existing `branch.<name>.*` git-config namespace.
- Store upstream mapping in `branch.<bookmark>.remote` and `branch.<bookmark>.merge`.
- Store PR merge-base metadata in `branch.<bookmark>.gh-merge-base`.
- Store managed JJ workspace paths in `branch.<bookmark>.t3-workspace-path`.
- Ignore missing recorded workspace paths on reads.
- Opportunistically clean up stale `t3-workspace-path` values on writes.

### 6. GitManager Changes

- Keep `GitManager` as the only high-level workflow service.
- Replace the current `gh pr checkout` local-mode flow with the same materialization flow already used for worktree mode.
- The new local-mode flow is: resolve PR, materialize a local branch or bookmark, checkout through `GitCore.checkoutBranch`, configure upstream, return `worktreePath: null`.
- JJ local PR preparation requires a clean workspace before checkout.
- Keep existing worktree-mode reuse logic. It should work once JJ `listBranches` returns `worktreePath` for app-managed workspaces.
- Keep PR remote and clone-url logic shared in `GitManager`.
- Thread `currentBranch` through `runCommitStep` into `GitCore.commit(..., branchHint)`.

### 7. Reliability And Non-UI Paths

- Make checkpoint capture exclude `.jj` explicitly.
- Make checkpoint restore and reset exclude `.jj` explicitly.
- Make checkpoint clean skip `.jj` explicitly by using `git clean -e .jj`.
- Keep checkpoint diff logic on raw git refs. Once capture excludes `.jj`, diff output stays correct automatically.
- Rely on the updated `GitService` so checkpoint refs, restore, and diff work in JJ workspaces via `GIT_DIR` and `GIT_WORK_TREE`.
- Keep provider worktree-branch auto-rename git-only.

### 8. Web Behavior

- Keep `api.git.*`, websocket methods, and persisted thread shape unchanged.
- Derive backend only from `git.listBranches`.
- Git backend behavior stays exactly as-is.
- JJ root local mode lists only current local bookmarks and already-recorded managed workspaces.
- In JJ root local mode, selecting an existing workspace reuses it. Selecting a current bookmark is a no-op. Non-current bookmarks without a workspace are not shown.
- JJ new-worktree mode lists local and remote bookmarks as workspace bases.
- In JJ new-worktree mode, selecting a bookmark only sets `thread.branch`. It does not call `git.checkout`.
- In JJ new-worktree mode, auto-select the current bookmark only when there is exactly one current local bookmark. If there are multiple, require explicit selection.
- In JJ existing-workspace mode, the selector may use `git.checkout` within that dedicated workspace because the mutation target is explicit.
- Hide “create branch” in JJ root local mode and JJ new-worktree base-selection mode. Keep it available only inside an existing JJ workspace.
- `ChatView` first-message worktree creation branches on backend. Git continues creating a temporary branch before `createWorktree`. JJ creates the workspace directly from the selected bookmark and does not synthesize a temp branch.
- `GitActionsControl` must stop using the current git-only status/branch mismatch invalidation when backend is JJ.
- `GitActionsControl` must disable mutating actions when backend is JJ, the thread is not already bound to a workspace, and `listBranches` reports more than one current local bookmark.
- The disabled reason for ambiguous JJ root-local actions must direct the user to create or switch to a dedicated workspace.
- `PullRequestThreadDialog` keeps the two-mode flow but uses neutral copy such as “current repo” and “dedicated workspace”.

## Rollout And Tracking

### Phase Checklist

- [x] Phase 1: repo context Effect service, cache, and raw command normalization
- [x] Phase 2: `GitCore` split and JJ backend primitives
- [x] Phase 3: `GitManager` PR flow cleanup and branch-hint plumbing
- [x] Phase 4: checkpointing, runtime ingestion, and workspace search safety
- [x] Phase 5: web JJ behavior and UX restrictions
- [x] Phase 6: tests, lint, and typecheck

### Progress Log

- 2026-03-10: PRD created from the JJ support plan. No implementation started yet.
- 2026-03-10: Phase 1 landed as a proper `RepoContextResolver` Effect service and layer. It added JJ-first detection, TTL caching, raw git/gh JJ env normalization, cache invalidation for `git init` and git worktree mutations, `.jj` workspace-search exclusion, and `git.listBranches.backend`.
- 2026-03-10: `GitCore.listBranches` now resolves backend explicitly and reports `backend: "git" | "jj" | null`. Existing direct `.git` checks in checkpointing/orchestration remain for Phase 4 instead of being folded into the Phase 1 patch.
- 2026-03-10: Refactored Phase 1 repo context plumbing into a proper `RepoContextResolver` Effect service with typed errors, `Cache`-backed TTL/in-flight dedupe, and direct consumption from `GitService`, `GitHubCli`, `GitCore`, and workspace search.
- 2026-03-11: Phase 2 landed in the current `GitCore` layer as backend-delegating JJ support. This pass added JJ-native status, commit, range context, branch listing, checkout, push/pull, PR ref materialization, bookmark metadata, and managed workspace create/remove behavior for git-backed JJ repos.
- 2026-03-11: Phase 3 landed in `GitManager`. Local PR preparation no longer uses `gh pr checkout`, JJ local PR prep now rejects dirty workspaces explicitly, and stacked-action commit execution passes the selected branch through `GitCore.commit(..., branchHint)`.
- 2026-03-11: The minimum exposed web slice for this pass landed: neutral PR dialog copy and JJ first-message worktree creation now call `createWorktree` directly from the selected bookmark instead of synthesizing a temporary git branch first.
- 2026-03-11: Browser validation exposed a JJ managed-workspace bug where `jj workspace add` failed if the app-managed parent directories did not already exist. `GitCore.JJ.createWorktree` now creates the parent directory tree first, and focused JJ coverage was added for managed workspace creation plus metadata recording.
- 2026-03-11: Post-review fixes tightened JJ correctness in the server layer. `GitCore.JJ.pushCurrentBranch` now fails closed on non-zero `jj git push` exits, JJ status/branch resolution prefers managed-workspace metadata over parent-bookmark unions, and local PR prep refreshes existing git/JJ head branches instead of reusing stale local state.
- 2026-03-11: Phase 4 landed. Provider runtime ingestion and checkpoint capture/revert no longer use direct `.git` checks, `apps/server/src/git/isRepo.ts` was removed, and JJ workspace placeholder checkpoints plus real checkpoint capture now work through the repo-context-aware checkpoint path.
- 2026-03-11: Phase 5 landed. The branch toolbar now treats JJ root-local mode as metadata-only bookmark selection, hides create-branch outside explicit JJ workspaces, preserves remote bookmarks in JJ new-worktree mode, and stops auto-selecting a JJ worktree base when multiple current local bookmarks exist. `GitActionsControl` also now disables ambiguous JJ root-local mutations with a dedicated-workspace message instead of the old detached-HEAD git fallback.
- 2026-03-11: Phase 6 landed as a focused stabilization pass. Added JJ regression coverage for managed workspace removal/metadata cleanup, upstream-based JJ pull behavior, dirty JJ pull rejection, and JJ dedicated-workspace PR preparation. No new public API or runtime-surface changes were required beyond those tests and helper-only test wiring.

### Verification Log

- 2026-03-10: `cd apps/server && bun run test -- src/git/repoContext.test.ts src/git/Layers/GitService.test.ts src/git/Layers/GitHubCli.test.ts src/git/Layers/GitCore.test.ts src/workspaceEntries.test.ts src/wsServer.test.ts`
- 2026-03-10: `bun lint`
- 2026-03-10: `bun typecheck`
- 2026-03-10: Playwriter browser validation against a throwaway JJ clone of `minioner`: added the alternate JJ workspace as a project, confirmed the current bookmark rendered in the branch picker, saw `origin/main` as a remote option, and switched the picker to `main` without browser-side errors.
- 2026-03-11: `cd apps/server && bun run test -- src/git/Layers/GitCore.test.ts src/git/Layers/GitManager.test.ts`
- 2026-03-11: `cd apps/server && bun run test -- src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/Layers/CheckpointReactor.test.ts`
- 2026-03-11: `cd apps/web && bun run test -- src/components/BranchToolbar.logic.test.ts src/components/GitActionsControl.logic.test.ts`
- 2026-03-11: `bun fmt`
- 2026-03-11: `bun lint`
- 2026-03-11: `bun typecheck`
- 2026-03-11: Playwriter browser validation against a disposable local git-backed JJ repo at `/tmp/t3code-jj-manual`: added the repo as a project, confirmed the branch picker surfaced multiple current bookmarks (`alpha`, `beta`, `main`), switched new-thread mode to `New worktree`, selected `beta` as the base, reproduced the missing-parent-directory failure in `GitCore.JJ.createWorktree.workspaceAdd`, fixed it server-side, reran verification, then replayed the same flow successfully. The retry created a managed workspace at `/home/ponbac/.t3/worktrees/t3code-jj-manual/beta`, recorded `branch.beta.t3-workspace-path`, and did not synthesize a temporary git branch.
- 2026-03-11: Playwriter browser validation against disposable local git-backed JJ repos at `/tmp/t3code-jj-validate-AUXRL5` and `/tmp/t3code-jj-validate2-0dEUe0`: added both repos as projects, confirmed JJ root-local mode initially showed `Select branch`, confirmed the branch picker only listed the current local bookmarks (`alpha`, `beta`) in root-local mode, selected `alpha` as metadata-only context, and verified the git actions menu now explains that multiple current JJ bookmarks require a dedicated workspace. In the second fresh repo, switched to `New worktree`, confirmed the base remained unselected with multiple current bookmarks, selected `beta`, sent a real turn, and verified the app created the managed workspace at `/home/ponbac/.t3/worktrees/t3code-jj-validate2-0dEUe0/beta`, switched the thread header to `Worktree`, kept the branch picker on `beta`, created `note.txt`, and rendered the turn diff successfully.
- 2026-03-11: `cd apps/server && bun run test -- src/git/Layers/GitCore.test.ts src/git/Layers/GitManager.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/Layers/CheckpointReactor.test.ts`
- 2026-03-11: `bun fmt`
- 2026-03-11: `bun lint`
- 2026-03-11: `bun typecheck`
- 2026-03-11: Playwriter browser validation against a disposable git-backed JJ clone of `https://github.com/pingdotgg/t3code.git` at `/tmp/t3code-jj-phase6-repo-xJHhHb/repo` using public PR `#930`: added the repo as a project, opened the branch picker, entered `#930`, selected `Checkout Pull Request`, waited for the dialog to resolve `fix: fix unclosable diff panel`, chose `Worktree`, and verified the draft thread switched to `Worktree` mode with branch `t3code/pr-930/fix-unclosable-drawer`. On disk, the repo recorded `branch.t3code/pr-930/fix-unclosable-drawer.t3-workspace-path=/home/ponbac/.t3/worktrees/repo/t3code-pr-930-fix-unclosable-drawer`, the managed workspace existed with `.jj`, and `jj log -r 't3code/pr-930/fix-unclosable-drawer'` resolved successfully inside that workspace.

### Handoff Rule

- Each implementation pass should end at a great manual testing point.
- Before pausing or handing off, ensure the current slice is usable enough for user-driven validation with the `playwriter` skill.
- Before pausing or handing off, run the `playwriter` validation pass and document it in the verification log in the same style as the 2026-03-10 JJ workspace validation.
- If a phase cannot yet be validated manually, continue implementing until the exposed workflow is coherent and testable.

## Test Cases And Acceptance Criteria

1. Repo-context resolution chooses JJ when both `.git` and `.jj` are present and falls back to git otherwise.
2. Repo-context cache invalidation works after `git init`, worktree creation, and worktree removal.
3. `GitService` and `GitHubCli` both work from an alternate JJ workspace with no local `.git`.
4. `workspaceEntries` respects ignore rules in JJ workspaces and never indexes `.jj`.
5. `git.listBranches` returns `backend: "git"` or `"jj"` correctly, and returns `backend: null` with `isRepo: false`.
6. JJ branch listing returns local bookmarks, remote bookmarks as `origin/foo`, and multiple `current: true` entries when appropriate.
7. JJ commit fails on ambiguous multi-current root state and succeeds when `branchHint` or a dedicated workspace makes the target explicit.
8. JJ push and pull use stored upstream config and fail explicitly when no unique target bookmark exists.
9. JJ worktree creation records `branch.<bookmark>.t3-workspace-path` and reuses recorded workspaces instead of creating duplicates.
10. JJ worktree removal forgets the workspace and cleans up stale workspace-path config.
11. PR thread preparation works in both local and dedicated-workspace modes for git and JJ without `gh pr checkout`.
12. JJ local PR preparation fails on dirty workspaces and succeeds on clean workspaces.
13. Checkpoint capture, restore, and diff work in JJ workspaces and never touch `.jj`.
14. The branch toolbar keeps git behavior unchanged, restricts JJ root-local choices, and requires explicit base selection for JJ new-worktree mode when multiple current bookmarks exist.
15. `GitActionsControl` disables ambiguous JJ root-local mutations and no longer self-invalidates on multiple current bookmarks.
16. Add automated tests only for the most critical touched behavior. Skip lower-signal coverage if the behavior can be validated more effectively another way.
17. Final acceptance for any implementation PR: critical touched tests pass via `bun run test`, `bun lint` passes, and `bun typecheck` passes.
18. Use the `playwriter` skill for UI or browser validation when required instead of broadening automated UI coverage by default.
19. Do not stop implementation at an arbitrary internal checkpoint. Stop only once the current phase reaches a strong manual validation point that a user and `playwriter` can exercise.

## Assumptions And Defaults

- JJ support requires `jj` to be installed and available on `PATH`.
- Only git-backed JJ repositories are supported in this pass.
- Only JJ workspaces created or explicitly recorded by T3 Code are discoverable and removable.
- The existing thread `branch` field continues to hold either a git branch name or a JJ bookmark name.
- The existing thread `worktreePath` field continues to hold either a git worktree path or a JJ workspace path.
- JJ support is intentionally workspace-first for predictability. The root JJ workspace is not the place for ambiguous bookmark switching or multi-bookmark mutations.
- `git.init` remains git-only in this pass.
