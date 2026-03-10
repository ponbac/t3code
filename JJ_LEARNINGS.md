# JJ Learnings

## Purpose

- Record implementation discoveries, gotchas, command quirks, and repo-specific constraints while JJ support is being built.
- Keep entries concise and actionable.
- Prefer concrete facts over speculation.

## How To Use This File

- Add a new dated entry when implementation uncovers something that would have saved time if known earlier.
- Include the affected area, the symptom, the root cause, and the resolution.
- If a learning changes scope or behavior, update `JJ_PRD.md` as well.
- When a work session ends with a `playwriter` validation pass, add an entry if the flow or outcome would help the next person repeat or extend that validation.

## Entry Template

```md
## YYYY-MM-DD - Short title

- Area:
- Symptom:
- Root cause:
- Resolution:
- Follow-up:
```

## Entries

## 2026-03-10 - Built Effect contexts can drop services that only later consumers need

- Area: wsServer test harness and Effect layer composition
- Symptom: `createServer()` failed in tests with `Service not found: t3/git/Services/RepoContextResolver` even though `makeServerRuntimeServicesLayer()` merged `RepoContextLive`.
- Root cause: The test harness was building an intermediate service context via `Layer.build(...)` and only retained outputs explicitly merged into that built layer. Services consumed internally by runtime layers were not guaranteed to survive into the later `Effect.provide(runtimeServices)` step unless they were also part of the built output layer.
- Resolution: In wsServer tests, explicitly merge `RepoContextLive` into the built base-services layer that gets materialized and later passed into `createServer()`.
- Follow-up: When future Effect services are added to runtime code, check any two-step `Layer.build(...)` test harnesses for the same output-retention issue instead of assuming merge/provide composition will preserve unused services automatically.

## 2026-03-10 - Repo-context cache must be invalidated across backend transitions

- Area: JJ/git repo detection cache
- Symptom: A path that was detected as plain git continued reporting `backend: "git"` after `jj git init --colocate` ran in the same process.
- Root cause: `RepoContextResolver` intentionally caches positive and negative lookups for a short TTL, so repo-shape changes made outside the normal invalidation hooks remain stale until the cache expires or is explicitly invalidated.
- Resolution: Added explicit cache invalidation hooks for `git init` and git worktree add/remove paths. In tests and future JJ mutation paths, call `RepoContextResolver.invalidate(...)` immediately after changing repo shape.
- Follow-up: When Phase 2 adds JJ workspace creation/removal and any JJ init-like flows, wire those mutations into `RepoContextResolver.invalidate(...)` the same way.

## 2026-03-10 - Repo-context runtime state must follow the existing Effect service pattern

- Area: JJ repo-context plumbing and server architecture
- Symptom: The first Phase 1 pass used a standalone helper-style module for stateful repo detection and caching instead of the repo's existing Effect `Services/` plus `Layers/` pattern.
- Root cause: The implementation optimized for quick reuse from non-Effect code and treated repo context as a thin utility, even though it owned runtime state, cache invalidation, in-flight dedupe, and process-environment normalization.
- Resolution: Replaced the helper-style module with `RepoContextResolver` as a proper Effect service and layer, then wired `GitService`, `GitHubCli`, `GitCore`, workspace search, and server runtime composition directly through that service.
- Follow-up: Future server-side runtime logic with owned state must start by fitting into the existing Effect architecture. Do not add new module-global helper caches when the codebase already has a service/layer pattern for the same class of problem.

## 2026-03-10 - Browser validation worked from a JJ alternate workspace

- Area: Playwriter manual validation against the app UI
- Symptom: Needed to confirm that the raw git/gh normalization actually surfaced through the real browser flow, not just through server tests.
- Root cause: Phase 1 is mostly plumbing, so the useful manual proof point is whether the app can add a JJ workspace project and drive branch data from a workspace with no local `.git`.
- Resolution: Used a throwaway clone of `minioner`, ran `jj git init --colocate`, added an alternate workspace, then validated in the browser that:
  - the JJ workspace could be added as a project,
  - the thread header showed the current bookmark,
  - the branch picker listed the current bookmark plus `origin/main`,
  - selecting `origin/main` switched the picker to `main` with no browser console errors.
- Follow-up: Repeat this flow after Phase 2/5 when JJ-native branch/workspace semantics land, because the current UI is still mostly git-shaped even though the raw repo-context plumbing now works.

## 2026-03-11 - JJ managed workspaces need their parent directories created first

- Area: `GitCore.JJ.createWorktree`
- Symptom: First-message JJ workspace creation failed in the browser with `jj workspace add ... Cannot access ... No such file or directory`.
- Root cause: The managed workspace path under `~/.t3/worktrees/<repo>/<bookmark>` was computed correctly, but the implementation passed it straight to `jj workspace add` without ensuring the parent directory existed.
- Resolution: Create `path.dirname(worktreePath)` recursively before invoking `jj workspace add`, and cover the behavior with a focused JJ `createWorktree` test that also asserts `branch.<bookmark>.t3-workspace-path` is recorded.
- Follow-up: Keep manual validation on the actual first-message worktree flow, because the happy-path unit tests did not surface this filesystem precondition until Playwriter drove the real UI.

## 2026-03-11 - JJ current-bookmark detection must prefer the managed workspace mapping over parent bookmark unions

- Area: JJ status compatibility and stacked-action safety
- Symptom: A managed workspace created from `beta` could render `alpha` as the current branch, and downstream commit/push/PR flows could target the wrong bookmark.
- Root cause: The initial JJ compatibility pass treated local bookmarks from both `@` and `@-` as equally current. In a fresh managed workspace, `@` is often unbookmarked while `@-` can still carry every root bookmark from the source commit.
- Resolution: Resolve JJ branch state in this order: actual local bookmarks on `@`, then the app-managed `branch.<bookmark>.t3-workspace-path` match for the current workspace, then a unique parent bookmark on `@-`. If the workspace is still ambiguous after that, keep `status.branch` null and require an explicit branch selection.
- Follow-up: Keep Phase 5 toolbar restrictions focused on genuinely ambiguous JJ roots, not on managed workspaces that now have reliable branch resolution.

## 2026-03-11 - JJ root-local UI must override detached-HEAD git fallbacks

- Area: JJ branch toolbar and git action UX
- Symptom: In a JJ root workspace with multiple current bookmarks, selecting `alpha` as thread context still left `git.status.branch` null, so the UI fell back to detached-HEAD messaging even though the real problem was JJ ambiguity.
- Root cause: The web layer initially only disabled mutating quick actions when the git-style quick action was still in a mutating state. In ambiguous JJ roots, the underlying git logic had already degraded to generic `show_hint` / detached-HEAD copy before the JJ override ran.
- Resolution: Treat ambiguous JJ root-local state as a higher-priority UI override. Keep the selection metadata-only, disable mutating actions, and replace the detached-HEAD warning with copy that explicitly directs the user to create or switch to a dedicated workspace.
- Follow-up: Future JJ UX work should treat `git.status.branch === null` as an implementation detail in ambiguous roots, not as proof that the user is in a generic detached-HEAD git state.

## 2026-03-11 - JJ bookmark pushes can be tripped up by the empty working-copy commit

- Area: JJ command quirks in tests and upstream-seeding flows
- Symptom: A JJ setup flow that committed onto a bookmark and then immediately ran `jj git push --bookmark <name> --allow-new` failed with `Won't push commit ... since it has no description`.
- Root cause: After `jj commit`, the bookmark is moved to `@-`, but the workspace is left on a fresh empty working-copy commit at `@`. In some setups, `jj git push` still rejects that empty working-copy state unless it has a description or the upstream is seeded some other way.
- Resolution: For pull/upstream tests, seed the remote branch and upstream config with plain git before running `jj git init --colocate`, or explicitly describe the empty working-copy commit before using `jj git push`.
- Follow-up: When future JJ workflows need deterministic setup rather than exercising JJ push itself, prefer seeding remote state with git so the test or validation isolates the behavior actually under test.
