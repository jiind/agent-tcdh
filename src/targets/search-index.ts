import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HubError } from "../errors.js";
import type { DiscoverySearchOptions } from "./schema.js";

/** Keep searchable text and a change marker in the same transaction as registry writes. */
export function createSearchIndex(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS target_search (id TEXT PRIMARY KEY, metadata TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS search_generation (slot INTEGER PRIMARY KEY CHECK(slot = 1), value TEXT NOT NULL) STRICT;`);
  const projection = (row: string) => `json_object('id', ${row}.id, 'name', ${row}.definition -> '$.name',
    'description', ${row}.definition -> '$.description', 'tags', ${row}.definition -> '$.tags',
    'aliases', ${row}.definition -> '$.aliases', 'connection', json_object('transport', ${row}.definition -> '$.connection.transport',
      'auth', json_object('type', ${row}.definition -> '$.connection.auth.type')),
    'capabilities', json((SELECT json_group_array(json_object('name', value -> '$.name', 'description', value -> '$.description'))
      FROM json_each(${row}.definition, '$.capabilities')))) `;
  const change = "UPDATE search_generation SET value = lower(hex(randomblob(16))) WHERE slot = 1;";
  if (!database.prepare("SELECT value FROM search_generation WHERE slot = 1").get()) {
    database.exec(`INSERT INTO target_search SELECT id, ${projection("targets")} FROM targets;
      INSERT INTO search_generation VALUES (1, lower(hex(randomblob(16))));`);
  }
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    database.exec(`CREATE TRIGGER IF NOT EXISTS target_search_${operation} AFTER ${operation} ON targets BEGIN
      ${operation === "DELETE" ? "DELETE FROM target_search WHERE id = OLD.id;"
        : `INSERT OR REPLACE INTO target_search VALUES (NEW.id, ${projection("NEW")});`}
      ${change}
    END;
    CREATE TRIGGER IF NOT EXISTS observation_search_${operation} AFTER ${operation} ON metadata_observations BEGIN ${change} END;`);
  }
}

const cursorSchema = z.strictObject({ generation: z.string().regex(/^[a-f0-9]{32}$/u), query: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().min(1).max(1_000_000), now: z.number().int().min(0).max(8_640_000_000_000_000) });

/** Bind a continuation to effective search options, registry generation, and observation time. */
export function searchContinuation(database: DatabaseSync, options: DiscoverySearchOptions) {
  const { cursor, offset, ...filters } = options;
  const query = createHash("sha256").update(JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  const generation = String(database.prepare("SELECT value FROM search_generation WHERE slot = 1").get()!.value);
  let start = offset;
  let now = Date.now();
  if (cursor !== "start") {
    let data: z.infer<typeof cursorSchema>;
    try {
      if (!cursor || !/^[\w-]+$/u.test(cursor)) throw new Error("Invalid encoding");
      data = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (offset !== 0 || data.query !== query || data.now > now) throw new Error("Invalid query or offset");
    } catch {
      throw new HubError(400, "INVALID_SEARCH_CURSOR", "Repeat the original search options or start a new search with cursor=start.");
    }
    if (data.generation !== generation) {
      throw new HubError(409, "SEARCH_CURSOR_CHANGED", "The registry changed. Restart the search with cursor=start.");
    }
    start = data.offset;
    now = data.now;
  }
  const next = start + options.limit;
  return { offset: start, now, nextCursor: (total: number) => next >= total || next > 1_000_000 ? null
    : Buffer.from(JSON.stringify({ generation, query, offset: next, now })).toString("base64url") };
}
