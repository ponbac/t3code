import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@t3tools/contracts";

const tempDirs: string[] = [];
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(Layer.provideMerge(NodeServices.layer));

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
  run("git", cwd, ["config", "user.email", "test@example.com"]);
  run("git", cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n", "utf8");
  run("git", cwd, ["add", "tracked.txt"]);
  run("git", cwd, ["commit", "-m", "Initial"]);
}

function runWithCheckpointStore<A>(effect: Effect.Effect<A, Error, CheckpointStore>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(CheckpointStoreTestLayer)));
}

describe("CheckpointStore", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes JJ metadata from checkpoint capture and restore", async () => {
    const cwd = makeTempDir("t3code-checkpoint-store-jj-");
    initColocatedJjRepo(cwd);

    const workspacePath = `${cwd}-workspace`;
    tempDirs.push(workspacePath);
    run("jj", cwd, ["workspace", "add", workspacePath]);

    const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/test-jj-workspace");
    const sentinelPath = path.join(workspacePath, ".jj", "t3-sentinel.txt");
    fs.writeFileSync(sentinelPath, "keep\n", "utf8");

    await runWithCheckpointStore(
      Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        yield* checkpointStore.captureCheckpoint({
          cwd: workspacePath,
          checkpointRef,
        });
      }),
    );

    const checkpointFiles = run("git", cwd, ["ls-tree", "-r", "--name-only", checkpointRef])
      .split("\n")
      .filter(Boolean);
    expect(checkpointFiles).toContain("tracked.txt");
    expect(checkpointFiles.some((filePath) => filePath.startsWith(".jj/"))).toBe(false);

    fs.writeFileSync(path.join(workspacePath, "tracked.txt"), "changed\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "scratch.txt"), "remove me\n", "utf8");

    const restored = await runWithCheckpointStore(
      Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return yield* checkpointStore.restoreCheckpoint({
          cwd: workspacePath,
          checkpointRef,
        });
      }),
    );

    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.existsSync(path.join(workspacePath, "scratch.txt"))).toBe(false);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("keep\n");
  });
});
