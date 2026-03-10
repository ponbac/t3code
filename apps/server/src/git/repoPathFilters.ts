export const EMPTY_EXCLUDED_TOP_LEVEL_NAMES = new Set<string>();

function normalizeRepoRelativePath(relativePath: string): string {
  return relativePath.replace(/^\.\/+/, "").replace(/^[\\/]+/, "");
}

export function isPathInExcludedTopLevelDirectory(
  relativePath: string,
  excludedTopLevelNames: ReadonlySet<string>,
): boolean {
  const normalizedPath = normalizeRepoRelativePath(relativePath);
  const [firstSegment] = normalizedPath.split(/[\\/]/);
  if (!firstSegment) {
    return false;
  }
  return excludedTopLevelNames.has(firstSegment);
}

export function buildExcludedTopLevelPathspecs(
  excludedTopLevelNames: ReadonlySet<string>,
): string[] {
  return Array.from(excludedTopLevelNames)
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => `:(exclude)${name}`);
}

export function buildWorktreePathspec(
  excludedTopLevelNames: ReadonlySet<string> = EMPTY_EXCLUDED_TOP_LEVEL_NAMES,
): string[] {
  return ["--", ".", ...buildExcludedTopLevelPathspecs(excludedTopLevelNames)];
}
