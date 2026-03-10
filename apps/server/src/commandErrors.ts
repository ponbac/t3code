import * as PlatformError from "effect/PlatformError";

/**
 * `runProcess()` throws this when the target executable is missing from PATH.
 * Effect's `ChildProcessSpawner` reports the same condition as a
 * `PlatformError` with `reason._tag === "NotFound"`, so use
 * `isCommandNotFoundError()` when callers need to support both paths.
 */
export class CommandNotFoundError extends Error {
  readonly command: string;
  override readonly cause: unknown;

  constructor(command: string, cause?: unknown) {
    super(`Command not found: ${command}`);
    this.name = "CommandNotFoundError";
    this.command = command;
    this.cause = cause;
  }
}

function matchesExpectedCommand(actualCommand: string, expectedCommand?: string): boolean {
  return expectedCommand === undefined || actualCommand === expectedCommand;
}

function extractChildProcessCommand(pathOrDescriptor: string | number | undefined): string | null {
  if (typeof pathOrDescriptor !== "string") {
    return null;
  }

  const trimmed = pathOrDescriptor.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const [command] = trimmed.split(/\s+/, 1);
  return command ?? null;
}

export function isCommandNotFoundError(error: unknown, command?: string): boolean {
  if (error instanceof CommandNotFoundError) {
    return matchesExpectedCommand(error.command, command);
  }

  if (!(error instanceof PlatformError.PlatformError)) {
    return false;
  }

  const reason = error.reason;
  if (reason._tag !== "NotFound" || reason.module !== "ChildProcess" || reason.method !== "spawn") {
    return false;
  }

  if (command === undefined) {
    return true;
  }

  const spawnedCommand = extractChildProcessCommand(reason.pathOrDescriptor);
  return spawnedCommand === command;
}
