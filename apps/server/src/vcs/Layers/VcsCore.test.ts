import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { GitStatusResult, VcsStatusResult } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import type { VcsServiceError } from "../Errors.ts";
import { VcsCoreLive } from "./VcsCore.ts";
import { VcsCore, type VcsCoreShape } from "../Services/VcsCore.ts";
import { VcsProcess, type VcsProcessShape } from "../Services/VcsProcess.ts";
import { VcsResolver, type VcsResolverShape } from "../Services/VcsResolver.ts";

const CLEAN_GIT_STATUS: GitStatusResult = {
  branch: null,
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function unexpectedCall(label: string) {
  return Effect.die(new Error(`Unexpected call: ${label}`));
}

function makeGitCore(overrides: Partial<GitCoreShape> = {}): GitCoreShape {
  return {
    status: () => unexpectedCall("GitCore.status"),
    statusDetails: () => unexpectedCall("GitCore.statusDetails"),
    prepareCommitContext: () => unexpectedCall("GitCore.prepareCommitContext"),
    commit: () => unexpectedCall("GitCore.commit"),
    pushCurrentBranch: () => unexpectedCall("GitCore.pushCurrentBranch"),
    readRangeContext: () => unexpectedCall("GitCore.readRangeContext"),
    readConfigValue: () => unexpectedCall("GitCore.readConfigValue"),
    listBranches: () => unexpectedCall("GitCore.listBranches"),
    listRemotes: () => unexpectedCall("GitCore.listRemotes"),
    pullCurrentBranch: () => unexpectedCall("GitCore.pullCurrentBranch"),
    createWorktree: () => unexpectedCall("GitCore.createWorktree"),
    removeWorktree: () => unexpectedCall("GitCore.removeWorktree"),
    renameBranch: () => unexpectedCall("GitCore.renameBranch"),
    createBranch: () => unexpectedCall("GitCore.createBranch"),
    checkoutBranch: () => unexpectedCall("GitCore.checkoutBranch"),
    initRepo: () => unexpectedCall("GitCore.initRepo"),
    listLocalBranchNames: () => unexpectedCall("GitCore.listLocalBranchNames"),
    ...overrides,
  };
}

function makeGitManager(overrides: Partial<GitManagerShape> = {}): GitManagerShape {
  return {
    status: () => unexpectedCall("GitManager.status"),
    runStackedAction: () => unexpectedCall("GitManager.runStackedAction"),
    ...overrides,
  };
}

function makeGitHubCli(overrides: Partial<GitHubCliShape> = {}): GitHubCliShape {
  return {
    execute: () => unexpectedCall("GitHubCli.execute"),
    listOpenPullRequests: () => unexpectedCall("GitHubCli.listOpenPullRequests"),
    createPullRequest: () => unexpectedCall("GitHubCli.createPullRequest"),
    getDefaultBranch: () => Effect.succeed(null),
    ...overrides,
  };
}

function makeVcsProcess(execute: VcsProcessShape["execute"]): VcsProcessShape {
  return { execute };
}

function makeVcsResolver(overrides: Partial<VcsResolverShape> = {}): VcsResolverShape {
  return {
    resolve: () =>
      Effect.succeed({
        backend: "jj",
        workspaceRoot: "/repo",
      }),
    ...overrides,
  };
}

async function runWithVcsCore<T>(input: {
  gitCore?: Partial<GitCoreShape>;
  gitManager?: Partial<GitManagerShape>;
  gitHubCli?: Partial<GitHubCliShape>;
  vcsProcess: VcsProcessShape["execute"];
  resolver?: Partial<VcsResolverShape>;
  effect: (vcsCore: VcsCoreShape) => Effect.Effect<T, VcsServiceError, never>;
}) {
  const dependencyLayer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(GitCore, makeGitCore(input.gitCore)),
    Layer.succeed(GitHubCli, makeGitHubCli(input.gitHubCli)),
    Layer.succeed(GitManager, makeGitManager(input.gitManager)),
    Layer.succeed(VcsProcess, makeVcsProcess(input.vcsProcess)),
    Layer.succeed(VcsResolver, makeVcsResolver(input.resolver)),
  );
  const layer = VcsCoreLive.pipe(Layer.provide(dependencyLayer));

  return await Effect.runPromise(
    Effect.gen(function* () {
      const vcsCore = yield* VcsCore;
      return yield* input.effect(vcsCore);
    }).pipe(Effect.provide(layer)),
  );
}

function handleJjRemoteResolution(
  args: ReadonlyArray<string>,
  input?: {
    readonly remoteListStdout?: string;
    readonly pushRemoteName?: string | null;
  },
) {
  if (args[0] === "config" && args[1] === "get" && args[2] === "git.push") {
    return Effect.succeed({
      code: input?.pushRemoteName ? 0 : 1,
      stdout: input?.pushRemoteName ? `${input.pushRemoteName}\n` : "",
      stderr: "",
    });
  }

  if (args[0] === "git" && args[1] === "remote" && args[2] === "list") {
    return Effect.succeed({
      code: 0,
      stdout: input?.remoteListStdout ?? "",
      stderr: "",
    });
  }

  return null;
}

function makeJjExecute(input: {
  readonly logStdout: string;
  readonly bookmarkStdout: string;
  readonly remoteListStdout?: string;
  readonly pushRemoteName?: string | null;
}): VcsProcessShape["execute"] {
  return ({ args }) => {
    const remoteResolution = handleJjRemoteResolution(args, input);
    if (remoteResolution) {
      return remoteResolution;
    }
    if (args[0] === "log") {
      return Effect.succeed({
        code: 0,
        stdout: input.logStdout,
        stderr: "",
      });
    }
    if (args[0] === "bookmark") {
      return Effect.succeed({
        code: 0,
        stdout: input.bookmarkStdout,
        stderr: "",
      });
    }
    return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
  };
}

describe("VcsCoreLive jj base bookmark inference", () => {
  it("returns the nearest local base bookmark for jj status", async () => {
    const result: VcsStatusResult = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      vcsProcess: makeJjExecute({
        logStdout: '[{"name":"main"}]\n',
        bookmarkStdout: '{"name":"main"}\n',
      }),
      effect: (vcsCore) => vcsCore.status({ cwd: "/repo" }),
    });

    expect(result.backend).toBe("jj");
    expect(result.refName).toBe("main");
    expect(result.refKind).toBe("bookmark");
  });

  it("marks inferred local base bookmarks as current in listRefs", async () => {
    const result = await runWithVcsCore({
      vcsProcess: makeJjExecute({
        logStdout: '[{"name":"main"}]\n',
        bookmarkStdout: ['{"name":"main"}', '{"name":"main","remote":"origin"}'].join("\n"),
      }),
      effect: (vcsCore) => vcsCore.listRefs({ cwd: "/repo" }),
    });

    expect(result.backend).toBe("jj");
    expect(result.refs).toEqual([
      {
        name: "main",
        kind: "bookmark",
        current: true,
        isDefault: true,
        workspacePath: null,
      },
      {
        name: "main@origin",
        kind: "remoteBookmark",
        current: false,
        isDefault: true,
        remoteName: "origin",
        workspacePath: null,
      },
    ]);
  });

  it("keeps multiple inferred local base bookmarks current and picks the first sorted one for status", async () => {
    const statusResult = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      vcsProcess: makeJjExecute({
        logStdout: '[{"name":"release/1.2"},{"name":"main"}]\n',
        bookmarkStdout: ['{"name":"release/1.2"}', '{"name":"main"}'].join("\n"),
      }),
      effect: (vcsCore) =>
        Effect.all({
          status: vcsCore.status({ cwd: "/repo" }),
          refs: vcsCore.listRefs({ cwd: "/repo" }),
        }),
    });

    expect(statusResult.status.refName).toBe("main");
    expect(
      statusResult.refs.refs.filter((ref) => ref.current).map((ref) => ref.name),
    ).toEqual(["main", "release/1.2"]);
  });

  it("ignores remote-only bookmarks when inferring jj base bookmarks", async () => {
    const result = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      vcsProcess: makeJjExecute({
        logStdout: "[]\n",
        bookmarkStdout: '{"name":"main","remote":"origin"}\n',
      }),
      effect: (vcsCore) =>
        Effect.all({
          status: vcsCore.status({ cwd: "/repo" }),
          refs: vcsCore.listRefs({ cwd: "/repo" }),
        }),
    });

    expect(result.status.refName).toBeNull();
    expect(result.refs.refs[0]).toEqual({
      name: "main@origin",
      kind: "remoteBookmark",
      current: false,
      isDefault: true,
      remoteName: "origin",
      workspacePath: null,
    });
  });

  it("prefers an open PR from another GitHub remote over a closed upstream PR", async () => {
    const result = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      gitHubCli: {
        execute: ({ args }) => {
          const repoFlagIndex = args.indexOf("--repo");
          const repoNameWithOwner =
            repoFlagIndex >= 0 && repoFlagIndex < args.length - 1 ? args[repoFlagIndex + 1] : "";
          if (repoNameWithOwner === "ponbac/t3code") {
            return Effect.succeed({
              code: 0,
              stdout: JSON.stringify([
                {
                  number: 1,
                  title: "Open fork PR",
                  url: "https://github.com/ponbac/t3code/pull/1",
                  baseRefName: "main",
                  headRefName: "jujutsu-vcs",
                  state: "OPEN",
                  updatedAt: "2026-03-09T22:35:12Z",
                },
              ]),
              stderr: "",
              signal: null,
              timedOut: false,
            });
          }
          if (repoNameWithOwner === "pingdotgg/t3code") {
            return Effect.succeed({
              code: 0,
              stdout: JSON.stringify([
                {
                  number: 743,
                  title: "Closed upstream PR",
                  url: "https://github.com/pingdotgg/t3code/pull/743",
                  baseRefName: "main",
                  headRefName: "jujutsu-vcs",
                  state: "CLOSED",
                  updatedAt: "2026-03-09T21:41:30Z",
                },
              ]),
              stderr: "",
              signal: null,
              timedOut: false,
            });
          }
          return unexpectedCall(`GitHubCli.execute ${args.join(" ")}`);
        },
        getDefaultBranch: () => Effect.succeed("main"),
      },
      vcsProcess: makeJjExecute({
        logStdout: '[{"name":"jujutsu-vcs"}]\n',
        bookmarkStdout: [
          '{"name":"jujutsu-vcs"}',
          '{"name":"jujutsu-vcs","remote":"origin"}',
          '{"name":"jujutsu-vcs","remote":"upstream"}',
        ].join("\n"),
        remoteListStdout: [
          "origin https://github.com/ponbac/t3code.git",
          "upstream https://github.com/pingdotgg/t3code.git",
        ].join("\n"),
        pushRemoteName: "origin",
      }),
      effect: (vcsCore) => vcsCore.status({ cwd: "/repo" }),
    });

    expect(result.pr).toEqual({
      number: 1,
      title: "Open fork PR",
      url: "https://github.com/ponbac/t3code/pull/1",
      baseRef: "main",
      headRef: "jujutsu-vcs",
      state: "open",
    });
  });
});

describe("VcsCoreLive jj workspace management", () => {
  it("creates a jj workspace from a bookmark", async () => {
    const processCalls: Array<ReadonlyArray<string>> = [];

    const result = await runWithVcsCore({
      vcsProcess: ({ args }) => {
        const remoteResolution = handleJjRemoteResolution(args);
        if (remoteResolution) {
          return remoteResolution;
        }
        processCalls.push(args);
        if (args[0] === "workspace" && args[1] === "add") {
          return Effect.succeed({
            code: 0,
            stdout: "",
            stderr: "",
          });
        }
        return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
      },
      effect: (vcsCore) =>
        vcsCore.createWorkspace({
          cwd: "/repo",
          refName: "main",
          refKind: "bookmark",
          path: "/tmp/t3code-jj-workspace",
        }),
    });

    expect(result).toEqual({
      backend: "jj",
      workspace: {
        path: "/tmp/t3code-jj-workspace",
        refName: "main",
        refKind: "bookmark",
      },
    });
    expect(processCalls).toContainEqual([
      "workspace",
      "add",
      "--name",
      "t3code-jj-workspace",
      "--revision",
      "main",
      "/tmp/t3code-jj-workspace",
    ]);
  });

  it("forgets and removes a jj workspace", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-jj-workspace-test-"));
    const workspacePath = path.join(tmpRoot, "workspace-a");
    fs.mkdirSync(workspacePath, { recursive: true });

    try {
      const processCalls: Array<ReadonlyArray<string>> = [];

      await runWithVcsCore({
        vcsProcess: ({ args }) => {
          const remoteResolution = handleJjRemoteResolution(args);
          if (remoteResolution) {
            return remoteResolution;
          }
          processCalls.push(args);
          if (args[0] === "workspace" && args[1] === "forget") {
            return Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
            });
          }
          return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
        },
        effect: (vcsCore) =>
          vcsCore.removeWorkspace({
            cwd: "/repo",
            path: workspacePath,
          }),
      });

      expect(processCalls).toContainEqual(["workspace", "forget", "workspace-a"]);
      expect(fs.existsSync(workspacePath)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
