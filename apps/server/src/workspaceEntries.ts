import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { Effect, Option } from "effect";
import { filterGitIgnoredPaths } from "./gitIgnore";
import { isPathInIgnoredWorkspaceDirectory } from "./workspaceIgnore";
import { runProcess } from "./processRunner";
import {
  DEFAULT_REPO_EXCLUDED_TOP_LEVEL_NAMES,
  RepoContextResolver,
  type RawRepoCommandContext,
} from "./git/Services/RepoContext.ts";
import { isPathInExcludedTopLevelDirectory } from "./git/repoPathFilters.ts";

import {
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

interface RankedWorkspaceEntry {
  entry: SearchableWorkspaceEntry;
  score: number;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();
const inFlightWorkspaceIndexBuilds = new Map<string, Promise<WorkspaceIndex>>();

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function normalizeQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedPath.includes(query)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

function compareRankedWorkspaceEntries(
  left: RankedWorkspaceEntry,
  right: RankedWorkspaceEntry,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function findInsertionIndex(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedWorkspaceEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function insertRankedEntry(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  // If output was truncated, the final token can be partial.
  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function buildWorkspaceIndexFromGit(
  rawRepoCommandContext: Option.Option<RawRepoCommandContext>,
): Promise<Option.Option<WorkspaceIndex>> {
  if (Option.isNone(rawRepoCommandContext) || rawRepoCommandContext.value.kind !== "repo") {
    return Option.none();
  }
  const repoCommandContext = rawRepoCommandContext.value;
  const ignoredDirectoryNames = new Set([
    ...DEFAULT_REPO_EXCLUDED_TOP_LEVEL_NAMES,
    ...IGNORED_DIRECTORY_NAMES,
    ...repoCommandContext.repoContext.excludedTopLevelNames,
  ]);

  const listedFiles = await runProcess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoCommandContext.cwd,
      env: repoCommandContext.env,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
    },
  ).catch(() => null);
  if (!listedFiles || listedFiles.code !== 0) {
    return Option.none();
  }

  const listedPaths = splitNullSeparatedPaths(
    listedFiles.stdout,
    Boolean(listedFiles.stdoutTruncated),
  )
    .map((entry) => toPosixPath(entry))
    .filter(
      (entry) =>
        entry.length > 0 && !isPathInExcludedTopLevelDirectory(entry, ignoredDirectoryNames),
    );
  const filePaths = await filterGitIgnoredPaths({
    cwd: repoCommandContext.cwd,
    relativePaths: listedPaths,
    ...(repoCommandContext.env ? { env: repoCommandContext.env } : {}),
  });

  const directorySet = new Set<string>();
  for (const filePath of filePaths) {
    for (const directoryPath of directoryAncestorsOf(filePath)) {
      if (!isPathInExcludedTopLevelDirectory(directoryPath, ignoredDirectoryNames)) {
        directorySet.add(directoryPath);
      }
    }
  }

  const directoryEntries = [...directorySet]
    .toSorted((left, right) => left.localeCompare(right))
    .map(
      (directoryPath): ProjectEntry => ({
        path: directoryPath,
        kind: "directory",
        parentPath: parentPathOf(directoryPath),
      }),
    )
    .map(toSearchableWorkspaceEntry);
  const fileEntries = [...new Set(filePaths)]
    .toSorted((left, right) => left.localeCompare(right))
    .map(
      (filePath): ProjectEntry => ({
        path: filePath,
        kind: "file",
        parentPath: parentPathOf(filePath),
      }),
    )
    .map(toSearchableWorkspaceEntry);

  const entries = [...directoryEntries, ...fileEntries];
  return Option.some({
    scannedAt: Date.now(),
    entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
    truncated: Boolean(listedFiles.stdoutTruncated) || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  });
}

async function buildWorkspaceIndex(
  cwd: string,
  rawRepoCommandContext: Option.Option<RawRepoCommandContext>,
): Promise<WorkspaceIndex> {
  const gitIndexed = await buildWorkspaceIndexFromGit(rawRepoCommandContext);
  if (Option.isSome(gitIndexed)) {
    return gitIndexed.value;
  }

  let pendingDirectories: string[] = [""];
  const entries: SearchableWorkspaceEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];
    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      WORKSPACE_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, {
            withFileTypes: true,
          });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan workspace entries at '${cwd}': ${error instanceof Error ? error.message : "unknown error"}`,
              { cause: error },
            );
          }
          return { relativeDir, dirents: null };
        }
      },
    );

    const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
      for (const dirent of dirents) {
        if (!dirent.name || dirent.name === "." || dirent.name === "..") {
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          continue;
        }

        const relativePath = toPosixPath(
          relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
        );
        if (isPathInIgnoredWorkspaceDirectory(relativePath)) {
          continue;
        }
        candidates.push({ dirent, relativePath });
      }
      return candidates;
    });

    for (const candidateEntries of candidateEntriesByDirectory) {
      for (const candidate of candidateEntries) {
        const entry = toSearchableWorkspaceEntry({
          path: candidate.relativePath,
          kind: candidate.dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(candidate.relativePath),
        });
        entries.push(entry);

        if (candidate.dirent.isDirectory()) {
          pendingDirectories.push(candidate.relativePath);
        }

        if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    scannedAt: Date.now(),
    entries,
    truncated,
  };
}

async function getWorkspaceIndex(
  cwd: string,
  rawRepoCommandContext: Option.Option<RawRepoCommandContext>,
): Promise<WorkspaceIndex> {
  const cached = workspaceIndexCache.get(cwd);
  if (cached && Date.now() - cached.scannedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = inFlightWorkspaceIndexBuilds.get(cwd);
  if (inFlight) {
    return inFlight;
  }

  const nextPromise = buildWorkspaceIndex(cwd, rawRepoCommandContext)
    .then((next) => {
      workspaceIndexCache.set(cwd, next);
      while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
        const oldestKey = workspaceIndexCache.keys().next().value;
        if (!oldestKey) break;
        workspaceIndexCache.delete(oldestKey);
      }
      return next;
    })
    .finally(() => {
      inFlightWorkspaceIndexBuilds.delete(cwd);
    });
  inFlightWorkspaceIndexBuilds.set(cwd, nextPromise);
  return nextPromise;
}

export function clearWorkspaceIndexCache(cwd: string): void {
  workspaceIndexCache.delete(cwd);
  inFlightWorkspaceIndexBuilds.delete(cwd);
}

export function searchWorkspaceEntries(
  input: ProjectSearchEntriesInput,
): Effect.Effect<ProjectSearchEntriesResult, Error, RepoContextResolver> {
  return Effect.gen(function* () {
    const repoContextResolver = yield* RepoContextResolver;
    const rawRepoCommandContext = yield* repoContextResolver
      .resolveRawCommandContext({ cwd: input.cwd })
      .pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<RawRepoCommandContext>())),
      );
    const index = yield* Effect.promise(() => getWorkspaceIndex(input.cwd, rawRepoCommandContext));
    const normalizedQuery = normalizeQuery(input.query);
    const limit = Math.max(0, Math.floor(input.limit));
    const rankedEntries: RankedWorkspaceEntry[] = [];
    let matchedEntryCount = 0;

    for (const entry of index.entries) {
      const score = scoreEntry(entry, normalizedQuery);
      if (score === null) {
        continue;
      }

      matchedEntryCount += 1;
      insertRankedEntry(rankedEntries, { entry, score }, limit);
    }

    return {
      entries: rankedEntries.map((candidate) => candidate.entry),
      truncated: index.truncated || matchedEntryCount > limit,
    };
  });
}
