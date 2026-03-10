import * as PlatformError from "effect/PlatformError";
import { describe, expect, it } from "vitest";

import { CommandNotFoundError, isCommandNotFoundError } from "./commandErrors.ts";

describe("isCommandNotFoundError", () => {
  it("matches typed runProcess command errors", () => {
    expect(isCommandNotFoundError(new CommandNotFoundError("gh"), "gh")).toBe(true);
    expect(isCommandNotFoundError(new CommandNotFoundError("gh"), "git")).toBe(false);
  });

  it("matches Effect child-process not-found errors", () => {
    const error = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "codex --version",
    });

    expect(isCommandNotFoundError(error, "codex")).toBe(true);
    expect(isCommandNotFoundError(error, "gh")).toBe(false);
  });

  it("ignores unrelated platform errors", () => {
    const error = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "codex --version",
    });

    expect(isCommandNotFoundError(error, "codex")).toBe(false);
  });
});
