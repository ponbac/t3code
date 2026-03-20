import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import { afterEach, assert, describe, it } from "vitest";

import { RepoContextLive } from "./Layers/RepoContext.ts";
import { RepoContextResolver } from "./Services/RepoContext.ts";

const tempDirs: string[] = [];
const RepoContextTestLayer = RepoContextLive.pipe(Layer.provideMerge(NodeServices.layer));

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

function initColocatedJjRepo(cwd: string): void {
  run("git", cwd, ["init"]);
  run("jj", cwd, ["git", "init", "--colocate"]);
}

function runWithRepoContext<A>(effect: Effect.Effect<A, Error, RepoContextResolver>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(RepoContextTestLayer)));
}

describe("repoContext", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers JJ when both .git and .jj are present", async () => {
    const cwd = makeTempDir("t3code-repo-context-jj-");
    initColocatedJjRepo(cwd);

    const repoContext = await runWithRepoContext(
      Effect.gen(function* () {
        const repoContextResolver = yield* RepoContextResolver;
        return yield* repoContextResolver.resolve(cwd);
      }),
    );

    assert.isTrue(Option.isSome(repoContext));
    if (Option.isSome(repoContext)) {
      assert.strictEqual(repoContext.value.backend, "jj");
      assert.strictEqual(repoContext.value.workspaceRoot, cwd);
      assert.strictEqual(repoContext.value.gitDir, path.join(cwd, ".git"));
    }
  });

  it("injects raw git env for alternate JJ workspaces", async () => {
    const cwd = makeTempDir("t3code-repo-context-jj-workspace-");
    initColocatedJjRepo(cwd);
    const workspacePath = `${cwd}-workspace`;
    run("jj", cwd, ["workspace", "add", workspacePath]);

    const rawRepoCommandContext = await runWithRepoContext(
      Effect.gen(function* () {
        const repoContextResolver = yield* RepoContextResolver;
        return yield* repoContextResolver.resolveRawCommandContext({ cwd: workspacePath });
      }),
    );

    assert.strictEqual(rawRepoCommandContext.kind, "repo");
    if (rawRepoCommandContext.kind === "repo") {
      assert.strictEqual(rawRepoCommandContext.repoContext.backend, "jj");
      assert.strictEqual(rawRepoCommandContext.env?.GIT_DIR, path.join(cwd, ".git"));
      assert.strictEqual(rawRepoCommandContext.env?.GIT_WORK_TREE, workspacePath);
    }
  });

  it("drops stale negative lookups after invalidation", async () => {
    const cwd = makeTempDir("t3code-repo-context-cache-");

    await runWithRepoContext(
      Effect.gen(function* () {
        const repoContextResolver = yield* RepoContextResolver;

        assert.isTrue(Option.isNone(yield* repoContextResolver.resolve(cwd)));

        run("git", cwd, ["init"]);

        assert.isTrue(Option.isNone(yield* repoContextResolver.resolve(cwd)));

        yield* repoContextResolver.invalidate(cwd);

        const repoContext = yield* repoContextResolver.resolve(cwd);
        assert.isTrue(Option.isSome(repoContext));
        if (Option.isSome(repoContext)) {
          assert.strictEqual(repoContext.value.backend, "git");
        }
      }),
    );
  });
});
