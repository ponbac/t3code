import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";
import { type GitBackend as GitBackendType } from "@t3tools/contracts";

import type { RepoContextError } from "../Errors.ts";

export const DEFAULT_REPO_EXCLUDED_TOP_LEVEL_NAMES = new Set([".git", ".jj"]);

export interface RepoContext {
  readonly backend: GitBackendType;
  readonly workspaceRoot: string;
  readonly gitRoot: string;
  readonly gitDir: string;
  readonly excludedTopLevelNames: ReadonlySet<string>;
}

export interface RepoRawCommandContext {
  readonly kind: "repo";
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly repoContext: RepoContext;
}

export interface NonRepoRawCommandContext {
  readonly kind: "non_repo";
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type RawRepoCommandContext = RepoRawCommandContext | NonRepoRawCommandContext;

export interface RepoContextResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<Option.Option<RepoContext>, RepoContextError>;
  readonly resolveRawCommandContext: (input: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  }) => Effect.Effect<RawRepoCommandContext, RepoContextError>;
  readonly invalidate: (
    ...pathsToInvalidate: Array<string | null | undefined>
  ) => Effect.Effect<void>;
}

export class RepoContextResolver extends ServiceMap.Service<
  RepoContextResolver,
  RepoContextResolverShape
>()("t3/git/Services/RepoContext/RepoContextResolver") {}
