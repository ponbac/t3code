import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const VcsBackend = Schema.Literals(["git", "jj"]);
export type VcsBackend = typeof VcsBackend.Type;

export const VcsRefKind = Schema.Literals([
  "branch",
  "bookmark",
  "remoteBranch",
  "remoteBookmark",
]);
export type VcsRefKind = typeof VcsRefKind.Type;

export const VcsCapabilities = Schema.Struct({
  supportsCommit: Schema.Boolean,
  supportsPush: Schema.Boolean,
  supportsPull: Schema.Boolean,
  supportsCreatePullRequest: Schema.Boolean,
  supportsCreateFeatureRef: Schema.Boolean,
  supportsCreateWorkspace: Schema.Boolean,
  supportsRemoveWorkspace: Schema.Boolean,
  supportsCreateRef: Schema.Boolean,
  supportsCheckoutRef: Schema.Boolean,
  supportsInit: Schema.Boolean,
  supportsCheckpointing: Schema.Boolean,
});
export type VcsCapabilities = typeof VcsCapabilities.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  kind: VcsRefKind,
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  workspacePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

export const VcsAction = Schema.Literals(["commit", "commit_push", "commit_push_pr"]);
export type VcsAction = typeof VcsAction.Type;

const VcsStatusPrState = Schema.Literals(["open", "closed", "merged"]);

const VcsStatusPr = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusPrState,
});

const VcsInputBase = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  backend: Schema.optional(VcsBackend),
});

export const VcsActionRefContext = Schema.Struct({
  contextRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  contextRefKind: Schema.optional(VcsRefKind),
});
export type VcsActionRefContext = typeof VcsActionRefContext.Type;

export const VcsStatusInput = Schema.Struct({
  ...VcsInputBase.fields,
  ...VcsActionRefContext.fields,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsListRefsInput = VcsInputBase;
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorkspaceInput = Schema.Struct({
  ...VcsInputBase.fields,
  refName: TrimmedNonEmptyStringSchema,
  refKind: VcsRefKind,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorkspaceInput = typeof VcsCreateWorkspaceInput.Type;

export const VcsRemoveWorkspaceInput = Schema.Struct({
  ...VcsInputBase.fields,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorkspaceInput = typeof VcsRemoveWorkspaceInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  ...VcsInputBase.fields,
  refName: TrimmedNonEmptyStringSchema,
  refKind: VcsRefKind,
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCheckoutRefInput = Schema.Struct({
  ...VcsInputBase.fields,
  refName: TrimmedNonEmptyStringSchema,
  refKind: VcsRefKind,
});
export type VcsCheckoutRefInput = typeof VcsCheckoutRefInput.Type;

export const VcsInitInput = VcsInputBase;
export type VcsInitInput = typeof VcsInitInput.Type;

export const VcsPullInput = Schema.Struct({
  ...VcsInputBase.fields,
  ...VcsActionRefContext.fields,
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const VcsRunActionInput = Schema.Struct({
  ...VcsInputBase.fields,
  ...VcsActionRefContext.fields,
  action: VcsAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  createFeatureRef: Schema.optional(Schema.Boolean),
});
export type VcsRunActionInput = typeof VcsRunActionInput.Type;

export const VcsStatusResult = Schema.Struct({
  backend: VcsBackend,
  capabilities: VcsCapabilities,
  refName: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  refKind: Schema.NullOr(VcsRefKind),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  pr: Schema.NullOr(VcsStatusPr),
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsListRefsResult = Schema.Struct({
  backend: VcsBackend,
  capabilities: VcsCapabilities,
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorkspaceResult = Schema.Struct({
  backend: VcsBackend,
  workspace: Schema.Struct({
    path: TrimmedNonEmptyStringSchema,
    refName: TrimmedNonEmptyStringSchema,
    refKind: VcsRefKind,
  }),
});
export type VcsCreateWorkspaceResult = typeof VcsCreateWorkspaceResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRefName: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

export const VcsRunActionResult = Schema.Struct({
  action: VcsAction,
  ref: Schema.Struct({
    status: Schema.Literals(["created", "skipped_not_requested"]),
    name: Schema.optional(TrimmedNonEmptyStringSchema),
    kind: Schema.optional(VcsRefKind),
  }),
  commit: Schema.Struct({
    status: Schema.Literals(["created", "skipped_no_changes"]),
    commitId: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: Schema.Literals(["pushed", "skipped_not_requested", "skipped_up_to_date"]),
    refName: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamRefName: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: Schema.Literals(["created", "opened_existing", "skipped_not_requested"]),
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseRef: Schema.optional(TrimmedNonEmptyStringSchema),
    headRef: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
});
export type VcsRunActionResult = typeof VcsRunActionResult.Type;
