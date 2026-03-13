import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";

interface HttpResponse {
  statusCode: number;
  contentType: string | null;
  body: string;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

async function withRouteServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void Effect.runPromise(
      Effect.gen(function* () {
        if (yield* tryHandleProjectFaviconRequest(url, res)) {
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }).pipe(Effect.provide(NodeServices.layer)),
    ).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      if (!res.writableEnded) {
        res.end(error instanceof Error ? error.message : "Unhandled error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected server address to be an object");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function request(baseUrl: string, pathname: string): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

describe("tryHandleProjectFaviconRequest", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 when cwd is missing", async () => {
    await withRouteServer(async (baseUrl) => {
      const response = await request(baseUrl, "/api/project-favicon");
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe("Missing cwd parameter");
    });
  });

  it("serves a well-known favicon file from the project root", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-root-");
    writeFile(path.join(projectDir, "favicon.svg"), "<svg>favicon</svg>");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>favicon</svg>");
    });
  });

  it("resolves icon href from source files when no well-known favicon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-source-");
    const iconPath = path.join(projectDir, "public", "brand", "logo.svg");
    writeFile(path.join(projectDir, "index.html"), '<link rel="icon" href="/brand/logo.svg">');
    writeFile(iconPath, "<svg>brand</svg>");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand</svg>");
    });
  });

  it("resolves icon link when href appears before rel in HTML", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-html-order-");
    const iconPath = path.join(projectDir, "public", "brand", "logo.svg");
    writeFile(path.join(projectDir, "index.html"), '<link href="/brand/logo.svg" rel="icon">');
    writeFile(iconPath, "<svg>brand-html-order</svg>");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand-html-order</svg>");
    });
  });

  it("resolves object-style icon metadata when href appears before rel", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-obj-order-");
    const iconPath = path.join(projectDir, "public", "brand", "obj.svg");
    writeFile(
      path.join(projectDir, "src", "root.tsx"),
      'const links = [{ href: "/brand/obj.svg", rel: "icon" }];',
    );
    writeFile(iconPath, "<svg>brand-obj-order</svg>");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand-obj-order</svg>");
    });
  });

  it("serves a fallback favicon when no icon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-fallback-");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });

  it("finds a favicon inside apps/frontend for monorepo roots", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-apps-frontend-");
    writeFile(path.join(projectDir, "apps", "frontend", "public", "favicon.ico"), "frontend-ico");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/x-icon");
      expect(response.body).toBe("frontend-ico");
    });
  });

  it("uses lexical order when multiple sibling roots contain favicons", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-lexical-siblings-");
    writeFile(path.join(projectDir, "apps", "zeta", "public", "favicon.ico"), "zeta-ico");
    writeFile(path.join(projectDir, "apps", "alpha", "public", "favicon.ico"), "alpha-ico");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/x-icon");
      expect(response.body).toBe("alpha-ico");
    });
  });

  it("resolves nested app source-file icons relative to the nested app root", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-nested-source-");
    writeFile(
      path.join(projectDir, "apps", "frontend", "index.html"),
      '<link rel="icon" href="/brand/logo.svg">',
    );
    writeFile(
      path.join(projectDir, "apps", "frontend", "public", "brand", "logo.svg"),
      "<svg>nested-app</svg>",
    );

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>nested-app</svg>");
    });
  });

  it("searches packages when apps has no favicon", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-packages-");
    writeFile(path.join(projectDir, "apps", "api", "README.md"), "no icon");
    writeFile(path.join(projectDir, "packages", "web", "public", "favicon.ico"), "package-ico");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/x-icon");
      expect(response.body).toBe("package-ico");
    });
  });

  it("searches direct child roots after apps and packages", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-direct-child-");
    writeFile(
      path.join(projectDir, "LD.Apport.Frontend", "public", "favicon.ico"),
      "direct-child-ico",
    );

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/x-icon");
      expect(response.body).toBe("direct-child-ico");
    });
  });

  it("ignores generated directories when enumerating candidate roots", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-ignore-generated-");
    writeFile(path.join(projectDir, "apps", "frontend", "dist", "favicon.ico"), "dist-ico");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });
});
