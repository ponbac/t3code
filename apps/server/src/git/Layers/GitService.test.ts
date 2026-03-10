import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach } from "vitest";

import { GitCommandError } from "../Errors.ts";
import { RepoContextResolver } from "../Services/RepoContext.ts";
import { RepoContextLive } from "./RepoContext.ts";
import { GitServiceLive } from "./GitService.ts";
import { GitService } from "../Services/GitService.ts";

const layer = it.layer(
  GitServiceLive.pipe(Layer.provideMerge(RepoContextLive), Layer.provideMerge(NodeServices.layer)),
);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function run(command: "git" | "jj", cwd: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

layer("GitServiceLive", (it) => {
  it.effect("runGit executes successful git commands", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.version",
        cwd: process.cwd(),
        args: ["--version"],
      });

      assert.equal(result.code, 0);
      assert.ok(result.stdout.toLowerCase().includes("git version"));
    }),
  );

  it.effect("runGit can return non-zero exit codes when allowed", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.allowNonZero",
        cwd: process.cwd(),
        args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
        allowNonZeroExit: true,
      });

      assert.notEqual(result.code, 0);
    }),
  );

  it.effect("runGit fails with GitCommandError when non-zero exits are not allowed", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* Effect.result(
        gitService.execute({
          operation: "GitProcess.test.failOnNonZero",
          cwd: process.cwd(),
          args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(GitCommandError)(result.failure));
        assert.equal(result.failure.operation, "GitProcess.test.failOnNonZero");
        assert.equal(result.failure.command, "git rev-parse --verify __definitely_missing_ref__");
      }
    }),
  );

  it.effect("runGit invalidates repo detection after git init", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir("t3code-git-service-init-");
      const gitService = yield* GitService;
      const repoContextResolver = yield* RepoContextResolver;

      assert.isTrue(Option.isNone(yield* repoContextResolver.resolve(cwd)));

      yield* gitService.execute({
        operation: "GitProcess.test.init",
        cwd,
        args: ["init"],
      });

      const repoContext = yield* repoContextResolver.resolve(cwd);
      assert.isTrue(Option.isSome(repoContext));
      if (Option.isSome(repoContext)) {
        assert.strictEqual(repoContext.value.backend, "git");
      }
    }),
  );

  it.effect("runGit normalizes execution for alternate JJ workspaces", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir("t3code-git-service-jj-");
      const workspacePath = `${cwd}-workspace`;
      run("git", cwd, ["init"]);
      run("jj", cwd, ["git", "init", "--colocate"]);
      run("jj", cwd, ["workspace", "add", workspacePath]);

      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.jjWorkspace",
        cwd: workspacePath,
        args: ["rev-parse", "--show-toplevel"],
      });

      assert.strictEqual(result.stdout.trim(), workspacePath);
    }),
  );
});
