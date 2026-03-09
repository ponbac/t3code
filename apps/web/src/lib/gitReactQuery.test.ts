import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction({ cwd: "/repo/a" })).not.toEqual(
      gitMutationKeys.runStackedAction({ cwd: "/repo/b" }),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull({ cwd: "/repo/a" })).not.toEqual(
      gitMutationKeys.pull({ cwd: "/repo/b" }),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction({ cwd: "/repo/a" }));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull({ cwd: "/repo/a" }));
  });
});
