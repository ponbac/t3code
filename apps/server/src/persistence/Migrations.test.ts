import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

type TableInfoRow = {
  readonly name: string;
};

describe("migrations", () => {
  it("adds proposed plan implementation columns for rebased stores that already recorded migration 15", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migrations-compat-"));
    const dbPath = path.join(tempDir, "state.sqlite");
    const db = new DatabaseSync(dbPath);

    try {
      db.exec(`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        );
      `);

      for (const [migrationId, name] of [
        [1, "OrchestrationEvents"],
        [2, "OrchestrationCommandReceipts"],
        [3, "CheckpointDiffBlobs"],
        [4, "ProviderSessionRuntime"],
        [5, "Projections"],
        [6, "ProjectionThreadSessionRuntimeModeColumns"],
        [7, "ProjectionThreadMessageAttachments"],
        [8, "ProjectionThreadActivitySequence"],
        [9, "ProviderSessionRuntimeMode"],
        [10, "ProjectionThreadsRuntimeMode"],
        [11, "OrchestrationThreadCreatedRuntimeMode"],
        [12, "ProjectionThreadsInteractionMode"],
        [13, "ProjectionThreadProposedPlans"],
        [14, "ProjectionThreadsVcsMetadata"],
        [15, "ProjectionTurnsSourceProposedPlan"],
      ] as const) {
        db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)").run(
          migrationId,
          name,
        );
      }

      db.exec(`
        CREATE TABLE projection_thread_proposed_plans (
          plan_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          plan_markdown TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }

    const layer = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<TableInfoRow>`
          PRAGMA table_info(projection_thread_proposed_plans)
        `;
      }).pipe(Effect.provide(layer)),
    );

    expect(rows.map((row) => row.name)).toEqual([
      "plan_id",
      "thread_id",
      "turn_id",
      "plan_markdown",
      "created_at",
      "updated_at",
      "implemented_at",
      "implementation_thread_id",
    ]);
  });
});
