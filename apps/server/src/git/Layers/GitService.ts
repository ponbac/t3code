/**
 * Git process helpers - Effect-native git execution with typed errors.
 *
 * Centralizes child-process git invocation for server modules. This module
 * only executes git commands and reports structured failures.
 *
 * @module GitServiceLive
 */
import path from "node:path";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "../Errors.ts";
import { RepoContextResolver, type RepoContextResolverShape } from "../Services/RepoContext.ts";
import {
  ExecuteGitInput,
  ExecuteGitResult,
  GitService,
  GitServiceShape,
} from "../Services/GitService.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function resolvePathFromCwd(cwd: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath) ? candidatePath : path.resolve(cwd, candidatePath);
}

function findPathArg(
  args: ReadonlyArray<string>,
  startIndex: number,
  direction: "forward" | "backward",
): string | null {
  if (direction === "forward") {
    for (let index = startIndex; index < args.length; index += 1) {
      const value = args[index];
      if (!value) {
        continue;
      }
      if (value === "--") {
        return args[index + 1] ?? null;
      }
      if (!value.startsWith("-")) {
        return value;
      }
    }
    return null;
  }

  for (let index = args.length - 1; index >= startIndex; index -= 1) {
    const value = args[index];
    if (!value) {
      continue;
    }
    if (!value.startsWith("-")) {
      return value;
    }
  }
  return null;
}

function resolveWorktreeMutationPath(cwd: string, args: ReadonlyArray<string>): string | null {
  if (args[0] !== "worktree") {
    return null;
  }

  const rawPath =
    args[1] === "add"
      ? findPathArg(args, 2, "forward")
      : args[1] === "remove"
        ? findPathArg(args, 2, "backward")
        : null;
  return rawPath ? resolvePathFromCwd(cwd, rawPath) : null;
}

function invalidateRepoContextForSuccessfulGitCommand(
  repoContextResolver: RepoContextResolverShape,
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void> {
  if (args[0] === "init") {
    return repoContextResolver.invalidate(cwd);
  }

  if (args[0] !== "worktree") {
    return Effect.void;
  }

  const worktreePath = resolveWorktreeMutationPath(cwd, args);
  if (args[1] === "add" || args[1] === "remove") {
    return repoContextResolver.invalidate(cwd, worktreePath);
  }

  if (args[1] === "prune") {
    return repoContextResolver.invalidate(cwd);
  }

  return Effect.void;
}

function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

const collectOutput = Effect.fn(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
): Effect.fn.Return<string, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
        });
      }
      text += decoder.decode(chunk, { stream: true });
    }),
  ).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));

  text += decoder.decode();
  return text;
});

const makeGitService = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repoContextResolver = yield* RepoContextResolver;

  const execute: GitServiceShape["execute"] = Effect.fnUntraced(function* (input) {
    const rawRepoCommandContext = yield* repoContextResolver
      .resolveRawCommandContext({
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
      })
      .pipe(Effect.mapError(toGitCommandError(input, "failed to resolve repository context.")));
    const commandInput = {
      ...input,
      args: [...input.args],
      env: rawRepoCommandContext.env,
    } as const;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const commandEffect = Effect.gen(function* () {
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make("git", commandInput.args, {
            cwd: commandInput.cwd,
            ...(commandInput.env ? { env: commandInput.env, extendEnv: true } : {}),
          }),
        )
        .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(commandInput, child.stdout, maxOutputBytes),
          collectOutput(commandInput, child.stderr, maxOutputBytes),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (!input.allowNonZeroExit && exitCode !== 0) {
        const trimmedStderr = stderr.trim();
        return yield* new GitCommandError({
          operation: commandInput.operation,
          command: quoteGitCommand(commandInput.args),
          cwd: commandInput.cwd,
          detail:
            trimmedStderr.length > 0
              ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
              : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
        });
      }

      if (exitCode === 0) {
        yield* invalidateRepoContextForSuccessfulGitCommand(
          repoContextResolver,
          commandInput.cwd,
          commandInput.args,
        );
      }

      return { code: exitCode, stdout, stderr } satisfies ExecuteGitResult;
    });

    return yield* commandEffect.pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(
              new GitCommandError({
                operation: commandInput.operation,
                command: quoteGitCommand(commandInput.args),
                cwd: commandInput.cwd,
                detail: `${quoteGitCommand(commandInput.args)} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  return {
    execute,
  } satisfies GitServiceShape;
});

export const GitServiceLive = Layer.effect(GitService, makeGitService);
