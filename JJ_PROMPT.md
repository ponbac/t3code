# JJ Implementation Prompt

Use this prompt to start or resume work on JJ support in this repo.

## Prompt

Implement JJ support in T3 Code using `JJ_PRD.md` as the source of truth.

Constraints:

- Keep the public `git.*` and `api.git.*` surface unchanged except for the contract changes already called out in `JJ_PRD.md`.
- Do not introduce a generic `vcs.*` layer or a `RepositoryManager` façade.
- Keep JJ support workspace-first and avoid ambiguous root-workspace mutations.
- Update `JJ_PRD.md` as implementation progresses.
- Record implementation learnings, gotchas, command quirks, and repo-specific pitfalls in `JJ_LEARNINGS.md`.
- Go light on tests. Add automated tests only for the most critical functionality and highest-risk regressions.
- When UI or browser validation is needed, use the `playwriter` skill rather than defaulting to broader automated UI coverage.
- Continue working until you reach a great manual testing point where a user and `playwriter` can step in and validate the current slice end to end.
- Do not stop at a partial plumbing checkpoint if the behavior is not yet exposed enough to validate manually.
- Before pausing, always run a `playwriter` validation pass against the current exposed slice in the same style as the 2026-03-10 JJ workspace pass: use a throwaway JJ repo/workspace when needed, exercise the real browser UI, and record what happened in `JJ_PRD.md` and `JJ_LEARNINGS.md`.
- Before considering work complete, run critical touched tests with `bun run test`, then `bun lint`, and `bun typecheck`.

Working docs:

- `JJ_PRD.md`
- `JJ_LEARNINGS.md`
- `AGENTS.md`

Implementation expectations:

- Start by checking the current status sections in `JJ_PRD.md`.
- Keep changes scoped to the agreed architecture in the PRD.
- If implementation forces a change in behavior or scope, update the PRD immediately rather than leaving the decision only in commit history or chat.
- Add or update only critical-path tests as each phase lands.
- Record any useful validation learnings from `playwriter` runs in `JJ_LEARNINGS.md` when they would help future work.
- End each work session at a strong manual validation point whenever feasible.
- Treat the `playwriter` validation pass as part of the stopping point, not as an optional follow-up.

Suggested resume checklist:

1. Read `JJ_PRD.md` top to bottom.
2. Read `JJ_LEARNINGS.md`.
3. Inspect current git-related server and web code before editing.
4. Implement the next unchecked phase in `JJ_PRD.md`.
5. Update the PRD progress log and verification log.
6. Run a `playwriter` validation pass against the latest exposed JJ flow before stopping.
7. Add any new learnings to `JJ_LEARNINGS.md`.
