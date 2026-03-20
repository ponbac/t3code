import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { assert, beforeEach, describe, it, vi } from "vitest";
import type { ProcessRunOptions, ProcessRunResult } from "./processRunner";
import { RepoContextLive } from "./git/Layers/RepoContext.ts";

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options?: ProcessRunOptions,
      ) => Promise<ProcessRunResult>
    >(),
}));

vi.mock("./processRunner", () => ({
  runProcess: runProcessMock,
}));

function processResult(
  overrides: Partial<ProcessRunResult> & Pick<ProcessRunResult, "stdout" | "code">,
): ProcessRunResult {
  return {
    stdout: overrides.stdout,
    code: overrides.code,
    stderr: overrides.stderr ?? "",
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    stdoutTruncated: overrides.stdoutTruncated ?? false,
    stderrTruncated: overrides.stderrTruncated ?? false,
  };
}

describe("searchWorkspaceEntries git-ignore chunking", () => {
  beforeEach(() => {
    runProcessMock.mockReset();
    vi.resetModules();
  });

  it("chunks git check-ignore stdin to avoid building giant strings", async () => {
    const ignoredPaths = Array.from(
      { length: 5000 },
      (_, index) => `ignored/${index.toString().padStart(5, "0")}/${"x".repeat(80)}.ts`,
    );
    const keptPaths = ["src/keep.ts", "docs/readme.md"];
    const listedPaths = [...ignoredPaths, ...keptPaths];
    let checkIgnoreCalls = 0;

    runProcessMock.mockImplementation(async (command, args, options) => {
      if (command === "jj" && args[0] === "workspace") {
        return processResult({ code: 1, stdout: "" });
      }

      if (command === "git" && args[0] === "rev-parse") {
        return processResult({
          code: 0,
          stdout: ["/virtual/workspace", "/virtual/workspace/.git", "/virtual/workspace/.git"].join(
            "\n",
          ),
        });
      }

      if (command === "git" && args[0] === "ls-files") {
        return processResult({ code: 0, stdout: `${listedPaths.join("\0")}\0` });
      }

      if (command === "git" && args[0] === "check-ignore") {
        checkIgnoreCalls += 1;
        const chunkPaths = (options?.stdin ?? "").split("\0").filter((value) => value.length > 0);
        const chunkIgnored = chunkPaths.filter((value) => value.startsWith("ignored/"));
        return processResult({
          code: chunkIgnored.length > 0 ? 0 : 1,
          stdout: chunkIgnored.length > 0 ? `${chunkIgnored.join("\0")}\0` : "",
        });
      }

      throw new Error(`Unexpected command: git ${args.join(" ")}`);
    });

    const { searchWorkspaceEntries } = await import("./workspaceEntries");
    const repoContextLayer = RepoContextLive.pipe(Layer.provideMerge(NodeServices.layer));
    const result = await Effect.runPromise(
      searchWorkspaceEntries({
        cwd: "/virtual/workspace",
        query: "",
        limit: 100,
      }).pipe(Effect.provide(repoContextLayer)),
    );

    assert.isAbove(checkIgnoreCalls, 1);
    assert.isFalse(result.entries.some((entry) => entry.path.startsWith("ignored/")));
    assert.isTrue(result.entries.some((entry) => entry.path === "src/keep.ts"));
  });
});
