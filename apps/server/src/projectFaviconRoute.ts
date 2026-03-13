import http from "node:http";
import path from "node:path";

import { Effect, FileSystem } from "effect";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "artifacts",
  "volumes",
  "playwright-report",
  "test-results",
  "bin",
  "obj",
]);

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
];

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

function resolveExistingPathOfType(
  fileSystem: FileSystem.FileSystem,
  projectRoot: string,
  candidatePath: string,
  expectedType: "File" | "Directory",
) {
  return Effect.gen(function* () {
    const resolvedPath = yield* fileSystem
      .realPath(candidatePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!resolvedPath) {
      return null;
    }

    // Reject symlinks or traversals that escape the requested project root.
    const relative = path.relative(projectRoot, resolvedPath);
    if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
      return null;
    }

    const info = yield* fileSystem
      .stat(resolvedPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return info?.type === expectedType ? resolvedPath : null;
  });
}

function findFaviconInSearchRoot(
  fileSystem: FileSystem.FileSystem,
  projectRoot: string,
  searchRoot: string,
) {
  return Effect.gen(function* () {
    for (const candidate of FAVICON_CANDIDATES) {
      const resolvedPath = yield* resolveExistingPathOfType(
        fileSystem,
        projectRoot,
        path.join(searchRoot, candidate),
        "File",
      );
      if (resolvedPath) {
        return resolvedPath;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = path.join(searchRoot, sourceFile);
      const content = yield* fileSystem
        .readFileString(sourcePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!content) {
        continue;
      }

      const href = extractIconHref(content);
      if (!href) {
        continue;
      }

      // Treat root-relative hrefs as app-relative, checking both `public/` and the app root.
      const cleanHref = href.replace(/^\//, "");
      for (const candidate of [
        path.join(searchRoot, "public", cleanHref),
        path.join(searchRoot, cleanHref),
      ]) {
        const resolvedPath = yield* resolveExistingPathOfType(
          fileSystem,
          projectRoot,
          candidate,
          "File",
        );
        if (resolvedPath) {
          return resolvedPath;
        }
      }
    }

    return null;
  });
}

function listChildDirectories(
  fileSystem: FileSystem.FileSystem,
  projectRoot: string,
  rootPath: string,
) {
  return Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectory(rootPath)
      .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

    const directories: string[] = [];
    for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
      if (entry.length === 0 || entry.includes("/") || entry.includes("\\")) {
        continue;
      }

      if (entry.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(entry)) {
        continue;
      }

      const candidatePath = path.join(rootPath, entry);
      const resolvedPath = yield* resolveExistingPathOfType(
        fileSystem,
        projectRoot,
        candidatePath,
        "Directory",
      );
      if (!resolvedPath) {
        continue;
      }

      directories.push(resolvedPath);
    }

    return directories;
  });
}

function listCandidateSearchRoots(fileSystem: FileSystem.FileSystem, projectRoot: string) {
  return Effect.gen(function* () {
    // Prefer conventional monorepo roots first, then fall back to other top-level children.
    const [appRoots, packageRoots, directChildRoots] = yield* Effect.all([
      listChildDirectories(fileSystem, projectRoot, path.join(projectRoot, "apps")),
      listChildDirectories(fileSystem, projectRoot, path.join(projectRoot, "packages")),
      listChildDirectories(fileSystem, projectRoot, projectRoot),
    ]);

    const fallbackRoots = directChildRoots.filter((directChildRoot) => {
      const baseName = path.basename(directChildRoot).toLowerCase();
      return baseName !== "apps" && baseName !== "packages";
    });

    return [...appRoots, ...packageRoots, ...fallbackRoots];
  });
}

function serveFaviconFile(filePath: string, res: http.ServerResponse) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";

    const data = yield* fileSystem.readFile(filePath).pipe(
      Effect.catch(() => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Read error");
        return Effect.fail(null);
      }),
    );

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(data);
  }).pipe(Effect.catch(() => Effect.void));
}

export function tryHandleProjectFaviconRequest(url: URL, res: http.ServerResponse) {
  if (url.pathname !== "/api/project-favicon") {
    return Effect.succeed(false);
  }

  const projectCwd = url.searchParams.get("cwd");
  if (!projectCwd) {
    return Effect.sync(() => {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing cwd parameter");
      return true;
    });
  }

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const projectRoot = yield* fileSystem
      .realPath(projectCwd)
      .pipe(Effect.catch(() => Effect.succeed(path.resolve(projectCwd))));
    const searchRoots = [
      projectRoot,
      ...(yield* listCandidateSearchRoots(fileSystem, projectRoot)),
    ];

    for (const searchRoot of searchRoots) {
      const faviconPath = yield* findFaviconInSearchRoot(fileSystem, projectRoot, searchRoot);
      if (faviconPath) {
        yield* serveFaviconFile(faviconPath, res);
        return true;
      }
    }

    yield* Effect.sync(() => {
      res.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(FALLBACK_FAVICON_SVG);
    });
    return true;
  });
}
