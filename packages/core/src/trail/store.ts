import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ResearchRun } from "../types.js";

export class RunStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        query TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  save(run: ResearchRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, created_at, updated_at, query, payload)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at=excluded.updated_at,
           query=excluded.query,
           payload=excluded.payload`,
      )
      .run(run.id, run.createdAt, run.updatedAt, run.query, JSON.stringify(run));
  }

  get(id: string): ResearchRun | null {
    const row = this.db
      .prepare(`SELECT payload FROM runs WHERE id = ?`)
      .get(id) as { payload: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload) as ResearchRun;
  }

  list(limit = 20): Array<Pick<ResearchRun, "id" | "query" | "createdAt" | "updatedAt" | "stage">> {
    const rows = this.db
      .prepare(
        `SELECT payload FROM runs ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ payload: string }>;
    return rows.map((r) => {
      const run = JSON.parse(r.payload) as ResearchRun;
      return {
        id: run.id,
        query: run.query,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        stage: run.stage,
      };
    });
  }
}
