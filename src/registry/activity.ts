import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HubError } from "../errors.js";
import { targetDefinitionSchema, targetIdSchema, type TargetDefinition } from "../targets/schema.js";
import { entityTag } from "../targets/version.js";

export const historyIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const historyQuerySchema = z.object({ target: targetIdSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(20),
  before: historyIdSchema.optional() }).strict();
export const observationSchema = z.object({ status: z.enum(["passed", "warning", "failed", "skipped"]),
  scope: z.literal("metadata"), executionVerified: z.literal(false) }).strict();
export const freshnessQuerySchema = z.object({ staleHours: z.coerce.number().min(0).max(8760).default(24),
  limit: z.coerce.number().int().min(1).max(1000).default(100), offset: z.coerce.number().int().min(0).default(0) }).strict();

/** Keep transactional history and revision-bound consumer observations beside the registry. */
export class RegistryActivity {
  /** Initialize bounded history triggers without inventing events for preexisting definitions. */
  constructor(private readonly database: DatabaseSync) {
    // 1. Store independent versions so restoration can detect deletion/recreation and subsequent edits.
    database.exec(`
      CREATE TABLE IF NOT EXISTS registry_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL,
        action TEXT NOT NULL, recorded_at TEXT NOT NULL,
        before_definition TEXT, after_definition TEXT, before_revision TEXT, after_revision TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS registry_history_target ON registry_history(target_id, seq);
      CREATE TABLE IF NOT EXISTS metadata_observations (
        target_id TEXT PRIMARY KEY, revision TEXT NOT NULL, checked_at TEXT NOT NULL, status TEXT NOT NULL
      ) STRICT;
    `);
    for (const [table, columns] of Object.entries({
      registry_history: ["seq", "target_id", "action", "recorded_at", "before_definition", "after_definition", "before_revision", "after_revision"],
      metadata_observations: ["target_id", "revision", "checked_at", "status"],
    })) {
      const kind = database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table);
      const actual = database.prepare("PRAGMA table_info(" + table + ")").all().map((row) => String(row.name));
      if (kind?.type !== "table" || actual.length !== columns.length || columns.some((column) => !actual.includes(column))) {
        throw new Error("Invalid registry activity schema; restore a consistent database backup.");
      }
    }
    // 2. SQLite triggers make all mutations, including atomic imports and undo, share rollback semantics.
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      const before = action === "INSERT" ? "NULL" : "OLD.definition";
      const after = action === "DELETE" ? "NULL" : "NEW.definition";
      database.exec(`CREATE TRIGGER IF NOT EXISTS history_${action.toLowerCase()} AFTER ${action} ON targets BEGIN
        INSERT INTO registry_history(target_id, action, recorded_at, before_definition, after_definition, before_revision, after_revision)
        VALUES (${action === "DELETE" ? "OLD.id" : "NEW.id"}, '${action.toLowerCase()}', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          ${before}, ${after}, ${action === "INSERT" ? "NULL" : "OLD.revision"}, ${action === "DELETE" ? "NULL" : "NEW.revision"});
        DELETE FROM registry_history WHERE seq IN (
          SELECT seq FROM (SELECT seq, row_number() OVER (ORDER BY seq DESC) AS n,
            sum(length(CAST(COALESCE(before_definition,'') AS BLOB)) + length(CAST(COALESCE(after_definition,'') AS BLOB)) + 512)
              OVER (ORDER BY seq DESC) AS bytes FROM registry_history) WHERE n > 1000 OR bytes > 16777216
        );
        ${action === "DELETE" ? "DELETE FROM metadata_observations WHERE target_id = OLD.id;" : ""}
      END;`);
    }
  }

  /** List bounded administrator history summaries with stable sequence pagination. */
  history(input: z.infer<typeof historyQuerySchema>) {
    const query = historyQuerySchema.parse(input);
    const rows = this.database.prepare(`SELECT seq, target_id, action, recorded_at FROM registry_history
      WHERE (? IS NULL OR target_id = ?) AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`)
      .all(query.target ?? null, query.target ?? null, query.before ?? null, query.before ?? null, query.limit + 1);
    const items = rows.slice(0, query.limit).map((row) => ({ id: Number(row.seq), targetId: String(row.target_id),
      action: String(row.action), recordedAt: String(row.recorded_at) }));
    return { items, nextBefore: rows.length > query.limit ? items.at(-1)!.id : null,
      retention: { maximumEntries: 1000, maximumDefinitionBytes: 16777216 }, executionVerified: false };
  }

  /** Retrieve a retained change, including definitions only through administrator access. */
  event(id: number) {
    const row = this.database.prepare("SELECT * FROM registry_history WHERE seq = ?").get(historyIdSchema.parse(id));
    if (!row) {
      throw new HubError(404, "HISTORY_NOT_FOUND", "The change was not found or has expired from bounded retention.");
    }
    return { id: Number(row.seq), targetId: String(row.target_id), action: String(row.action), recordedAt: String(row.recorded_at),
      before: row.before_definition === null ? null : targetDefinitionSchema.parse(JSON.parse(String(row.before_definition))),
      after: row.after_definition === null ? null : targetDefinitionSchema.parse(JSON.parse(String(row.after_definition))),
      afterRevision: row.after_revision === null ? null : String(row.after_revision) };
  }

  /** Preview or atomically invert the latest retained change only if its exact destination version still exists. */
  undo(id: number, apply: boolean, mutate: (targetId: string, before: TargetDefinition | null, exists: boolean) => void) {
    // 1. Lock competing writers while comparing the event, current slot, and latest target history.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.event(id);
      const latest = this.database.prepare("SELECT max(seq) AS seq FROM registry_history WHERE target_id = ?").get(event.targetId);
      const current = this.database.prepare("SELECT revision FROM targets WHERE id = ?").get(event.targetId);
      const ready = Number(latest?.seq) === event.id && (event.afterRevision === null ? !current : current?.revision === event.afterRevision);
      if (!ready && apply) {
        throw new HubError(412, "UNDO_CONFLICT", "A later change exists. Undo the latest change or inspect the current target; nothing was overwritten.");
      }
      // 2. Inversion creates a new ordinary event and never rewrites or erases past events.
      if (ready && apply) {
        mutate(event.targetId, event.before, Boolean(current));
      }
      this.database.exec("COMMIT");
      return { id: event.id, targetId: event.targetId, ready, applied: ready && apply,
        operation: event.before === null ? "remove" : event.after === null ? "create" : "replace", executionVerified: false };
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /** Save a consumer-reported observation only for a single exact current target revision. */
  observe(id: string, etag: string, input: z.infer<typeof observationSchema>) {
    const observation = observationSchema.parse(input);
    const row = this.database.prepare(`INSERT INTO metadata_observations(target_id, revision, checked_at, status)
      SELECT id, revision, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ? FROM targets WHERE id = ? AND ? = '"' || revision || '"'
      ON CONFLICT(target_id) DO UPDATE SET revision=excluded.revision, checked_at=excluded.checked_at, status=excluded.status
      RETURNING checked_at`).get(observation.status, targetIdSchema.parse(id), etag);
    if (!row) {
      throw new HubError(412, "OBSERVATION_CONFLICT", "The observed definition changed or was deleted; inspect it again.");
    }
    return { id, checkedAt: String(row.checked_at), ...observation, source: "consumer-report" };
  }

  /** Report freshness without contacting providers or treating a registry write as an inspection. */
  freshness(input: z.infer<typeof freshnessQuerySchema>) {
    const query = freshnessQuerySchema.parse(input);
    const now = Date.now();
    const rows = this.database.prepare(`SELECT t.id, t.revision, t.enabled, o.revision AS observed_revision, o.checked_at, o.status
      FROM targets t LEFT JOIN metadata_observations o ON o.target_id = t.id ORDER BY t.id LIMIT ? OFFSET ?`)
      .all(query.limit, query.offset);
    return { evaluatedAt: new Date(now).toISOString(), staleHours: query.staleHours,
      total: Number(this.database.prepare("SELECT count(*) AS n FROM targets").get()!.n),
      items: rows.map((row) => ({ id: String(row.id), enabled: Boolean(row.enabled), etag: entityTag(String(row.revision)),
        checkedAt: row.checked_at ?? null, status: row.status ?? "unknown", source: "consumer-report",
        state: row.checked_at === null ? "unknown" : row.revision !== row.observed_revision ? "changed"
          : now - Date.parse(String(row.checked_at)) >= query.staleHours * 3600000 ? "stale" : "fresh",
        executionVerified: false })), limit: query.limit, offset: query.offset };
  }
}
