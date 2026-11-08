import { RegistryActivity } from "../registry/activity.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HubError } from "../errors.js";
import type { SearchOptions, SearchResult, Target, TargetDefinition } from "./schema.js";
import { importOptionsSchema, MAX_SNAPSHOT_TARGETS, parseSnapshot, serializeSnapshot, snapshotSchema } from "../registry/schema.js";
import type { ImportOptions, ImportResult, RegistrySnapshot } from "../registry/schema.js";
import { entityTag } from "./version.js";
import type { EntityCondition, VersionedTarget } from "./version.js";

/** Persist target metadata in SQLite and provide filtered, ranked, paginated discovery. */
export class TargetStore {
  private readonly database: DatabaseSync;
  readonly activity: RegistryActivity;

  /** Prepare the storage directory and connection and validate the schema version. */
  constructor(path: string) {
    // 1. Create the parent directory for file-backed storage.
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    // 2. Open the database and reject unsupported versions before making changes.
    this.database = new DatabaseSync(path);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000");
      const initialVersion = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
      if (![0, 1, 2, 3].includes(initialVersion)) {
        throw new Error("Unsupported database schema version.");
      }
      this.database.exec("PRAGMA journal_mode = WAL");

      // 3. Recheck the version under a write lock and prepare revision storage.
      this.database.exec("BEGIN IMMEDIATE");
      const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
      if (![0, 1, 2, 3].includes(version)) {
        throw new Error("Unsupported database schema version.");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS targets (
          id TEXT PRIMARY KEY,
          protocol TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          definition TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision TEXT NOT NULL DEFAULT ''
        ) STRICT;
      `);
      const columns = this.database.prepare("PRAGMA table_info(targets)").all();
      if (!columns.some((column) => column.name === "revision")) {
        if (version >= 2) {
          throw new Error("Invalid database schema: target revision column is missing.");
        }
        this.database.exec("ALTER TABLE targets ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
      }

      // 4. Preserve definitions, backfill revisions, and commit the schema version.
      if (version < 2) {
        const update = this.database.prepare("UPDATE targets SET revision = ? WHERE id = ?");
        for (const row of this.database.prepare("SELECT id FROM targets").all()) {
          update.run(randomUUID(), String(row.id));
        }
      }
      this.activity = new RegistryActivity(this.database);
      this.database.exec("PRAGMA user_version = 3");
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      this.database.close();
      throw error;
    }
  }

  /** Invert a guarded event using the same mutation paths as normal registry administration. */
  undoHistory(id: number, apply: boolean) {
    return this.activity.undo(id, apply, (targetId, before, exists) => {
      if (before === null) {
        this.remove(targetId);
      } else if (exists) {
        this.update(targetId, before);
      } else {
        this.create(before);
      }
    });
  }

  /** Close the database connection and prepared statements. */
  close(): void {
    this.database.close();
  }

  /** Register a target with a previously unused id. */
  create(definition: TargetDefinition): Target {
    return this.createVersioned(definition).target;
  }

  /** Register a target and return its version from the same SQL statement. */
  createVersioned(definition: TargetDefinition): VersionedTarget {
    // 1. Prepare timestamps and normalized metadata.
    const now = new Date().toISOString();
    const normalized = { ...definition, tags: [...new Set(definition.tags)] };

    // 2. Resolve primary key conflicts in the database and return the created target.
    const row = this.database.prepare(`
      INSERT INTO targets (id, protocol, enabled, definition, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING *
    `).get(normalized.id, normalized.protocol, Number(normalized.enabled), JSON.stringify(normalized), now, now, randomUUID());
    if (!row) {
      throw new HubError(409, "TARGET_EXISTS", "This target id is already registered.");
    }

    return this.versionedRow(row);
  }

  /** Get a target by id or report that it does not exist. */
  get(id: string): Target {
    return this.getVersioned(id).target;
  }

  /** Read a target and its revision in one query. */
  getVersioned(id: string): VersionedTarget {
    const row = this.database.prepare("SELECT * FROM targets WHERE id = ?").get(id);
    if (!row) {
      throw new HubError(404, "TARGET_NOT_FOUND", "The registered target was not found.");
    }

    return this.versionedRow(row);
  }

  /** Replace the complete target definition while preserving its creation timestamp. */
  update(id: string, definition: TargetDefinition, condition?: EntityCondition): Target {
    return this.updateVersioned(id, definition, condition).target;
  }

  /** Atomically replace a matching target and return its new revision. */
  updateVersioned(id: string, definition: TargetDefinition, condition?: EntityCondition): VersionedTarget {
    // 1. Require the path and body to identify the same target.
    if (id !== definition.id) {
      throw new HubError(400, "TARGET_ID_MISMATCH", "Path and body target ids must match.");
    }
    const now = new Date().toISOString();
    const normalized = { ...definition, tags: [...new Set(definition.tags)] };
    const match = this.matchClause(condition);

    // 2. Update atomically and return the preserved creation timestamp.
    const row = this.database.prepare(`
      UPDATE targets SET protocol = ?, enabled = ?, definition = ?, updated_at = ?, revision = ?
      WHERE id = ? ${match.sql} RETURNING *
    `).get(normalized.protocol, Number(normalized.enabled), JSON.stringify(normalized), now, randomUUID(), id, ...match.values);
    if (!row) {
      if (condition) {
        throw new HubError(412, "PRECONDITION_FAILED", "The target changed or was deleted. Retrieve its current version before retrying.");
      }
      throw new HubError(404, "TARGET_NOT_FOUND", "The registered target was not found.");
    }

    return this.versionedRow(row);
  }

  /** Delete a target so subsequent discovery no longer returns it. */
  remove(id: string, condition?: EntityCondition): void {
    const match = this.matchClause(condition);
    const result = this.database.prepare("DELETE FROM targets WHERE id = ? " + match.sql).run(id, ...match.values);
    if (result.changes === 0) {
      if (condition) {
        throw new HubError(412, "PRECONDITION_FAILED", "The target changed or was deleted. Retrieve its current version before retrying.");
      }
      throw new HubError(404, "TARGET_NOT_FOUND", "The registered target was not found.");
    }
  }

  /** Export all definitions, including disabled targets, in stable order. */
  exportSnapshot(): RegistrySnapshot {
    // 1. Read all definitions in one query and enforce the target count limit.
    const rows = this.database.prepare("SELECT definition FROM targets ORDER BY id LIMIT ?")
      .all(MAX_SNAPSHOT_TARGETS + 1);
    if (rows.length > MAX_SNAPSHOT_TARGETS) {
      throw new HubError(413, "SNAPSHOT_TOO_LARGE", "Snapshots may contain at most 10000 targets.");
    }

    // 2. Include the format version and export timestamp and check importable size.
    const snapshot = snapshotSchema.parse({
      format: "agent-tcdh", version: 1, exportedAt: new Date().toISOString(),
      targets: rows.map((row) => JSON.parse(String(row.definition))),
    });
    serializeSnapshot(snapshot);
    return snapshot;
  }

  /** Validate the whole snapshot and apply the conflict policy in a single transaction. */
  importSnapshot(snapshot: RegistrySnapshot, options: ImportOptions): ImportResult {
    // 1. Validate all input before preparing existing-target queries.
    const validated = parseSnapshot(snapshot);
    const policy = importOptionsSchema.parse(options);
    serializeSnapshot(validated);
    const exists = this.database.prepare("SELECT id FROM targets WHERE id = ?");

    // 2. Resolve duplicates within the transaction so previews and writes agree.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = new Set(validated.targets.filter((target) => exists.get(target.id)).map((target) => target.id));
      if (policy.onConflict === "error" && existing.size > 0) {
        throw new HubError(409, "SNAPSHOT_CONFLICT", "Targets are already registered: " + [...existing].slice(0, 10).join(", "));
      }
      const result: ImportResult = {
        total: validated.targets.length, inserted: 0, replaced: 0, skipped: 0, dryRun: policy.dryRun,
      };

      // 3. Classify each target and write only when not previewing.
      for (const target of validated.targets) {
        if (existing.has(target.id)) {
          if (policy.onConflict === "skip") {
            result.skipped++;
          } else {
            result.replaced++;
            if (!policy.dryRun) {
              this.update(target.id, target);
            }
          }
        } else {
          result.inserted++;
          if (!policy.dryRun) {
            this.create(target);
          }
        }
      }

      // 4. Commit only when every item succeeds; roll back this entire import on failure.
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /** Apply all filters, rank matches, and return the total count and requested page. */
  search(options: SearchOptions): SearchResult {
    // 1. Load candidates matching enabled-state and protocol filters.
    const rows = this.database.prepare(`
      SELECT * FROM targets
      WHERE (? = 1 OR enabled = 1) AND (? IS NULL OR protocol = ?)
    `).all(Number(options.includeDisabled), options.protocol ?? null, options.protocol ?? null);
    const terms = [...new Set(options.q.toLowerCase().split(/\s+/u).filter(Boolean))];

    // 2. Apply tag and keyword filters and calculate weighted field matches.
    const matches = rows.map((row) => this.readRow(row)).flatMap((target) => {
      if (options.tag && !target.tags.some((tag) => tag.toLowerCase() === options.tag?.toLowerCase())) {
        return [];
      }
      const fields = [
        { text: target.id, weight: 12 },
        { text: target.name, weight: 10 },
        { text: target.description, weight: 3 },
        ...target.tags.map((tag) => ({ text: tag, weight: 8 })),
        ...target.capabilities.flatMap((capability) => [
          { text: capability.name, weight: 6 },
          { text: capability.description, weight: 2 },
        ]),
      ];
      const scores = terms.map((term) => fields.reduce(
        (score, field) => score + (field.text.toLowerCase().includes(term) ? field.weight : 0), 0,
      ));
      if (scores.some((score) => score === 0)) {
        return [];
      }

      return [{ target, score: scores.reduce((total, score) => total + score, 0) }];
    });

    // 3. Break ranking ties by id and slice the requested page.
    matches.sort((left, right) => right.score - left.score
      || (left.target.id < right.target.id ? -1 : left.target.id > right.target.id ? 1 : 0));
    return {
      items: matches.slice(options.offset, options.offset + options.limit).map((match) => match.target),
      total: matches.length,
      limit: options.limit,
      offset: options.offset,
    };
  }

  /** Decode a stored row into a target with connection details. */
  private readRow(row: Record<string, unknown>): Target {
    return {
      ...JSON.parse(String(row.definition)) as TargetDefinition,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Build the target body and HTTP revision from the same row. */
  private versionedRow(row: Record<string, unknown>): VersionedTarget {
    return { target: this.readRow(row), etag: entityTag(String(row.revision)) };
  }

  /** Translate a version condition into a parameterized SQL clause. */
  private matchClause(condition: EntityCondition | undefined): { sql: string; values: string[] } {
    if (!condition || condition.kind === "any") {
      return { sql: "", values: [] };
    }
    if (condition.tags.length === 0) {
      return { sql: "AND 0", values: [] };
    }

    return { sql: "AND revision IN (" + condition.tags.map(() => "?").join(",") + ")", values: condition.tags };
  }
}
