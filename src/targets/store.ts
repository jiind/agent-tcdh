import { observedFreshness, RegistryActivity } from "../registry/activity.js";
import { createSearchIndex, searchContinuation } from "./search-index.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HubError } from "../errors.js";
import { searchSuggestionLimit, searchSummaryLimits, targetLookupLimits } from "./schema.js";
import type { DiscoverySearchOptions, DiscoverySearchResult, SearchOptions, SearchResult,
  SearchSummaryItem, SearchSummaryResult, Target, TargetDefinition, TargetLookupResult } from "./schema.js";
import { importOptionsSchema, MAX_SNAPSHOT_TARGETS, parseSnapshot, serializeSnapshot, snapshotSchema } from "../registry/schema.js";
import type { ImportOptions, ImportResult, RegistrySnapshot } from "../registry/schema.js";
import { entityTag } from "./version.js";
import type { EntityCondition, VersionedTarget } from "./version.js";

/** Treat hyphens and underscores as word separators and compose equivalent Unicode text. */
function normalizeSearchText(text: string): string {
  return text.normalize("NFC").replace(/[-_\s]+/gu, " ").trim();
}

/** Bound a description and keep surrogate pairs intact at the truncation point. */
function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…";
}

/** Read the declared remote authentication scheme from connection metadata. */
type SearchConnection = { transport: Target["connection"]["transport"]; auth?: { type?: SearchSummaryItem["authType"] | null } | undefined };
type SearchMetadata = Pick<TargetDefinition, "id" | "name" | "description" | "tags" | "aliases">
  & { connection: SearchConnection; capabilities: Pick<TargetDefinition["capabilities"][number], "name" | "description">[] };

function remoteAuthType(connection: SearchConnection) {
  return connection.transport === "stdio" ? undefined : connection.auth?.type ?? "none";
}

/** Count distinct terms covered by one capability and optionally add its field weights. */
function matchCapability(name: string, description: string, terms: string[], scores?: number[]) {
  let hits = 0;
  let nameHits = 0;
  for (let index = 0; index < terms.length; index++) {
    const term = terms[index]!;
    const inName = name.includes(term);
    const inDescription = description.includes(term);
    if (!inName && !inDescription) {
      continue;
    }
    hits++;
    nameHits += Number(inName);
    if (scores) {
      scores[index] = scores[index]! + (inName ? 6 : 0) + (inDescription ? 2 : 0);
    }
  }
  return { hits, nameHits };
}

/** Show capabilities that match the query's terms, with the closest matches first. */
function summarizeTarget(target: Target, query: SearchQuery, inputs?: boolean): SearchSummaryItem {
  const { terms, toSearchable } = query;
  const matched = terms.length === 0 && !inputs ? [] : target.capabilities.flatMap(({ name, description, inputSchema }) => {
    const { hits, nameHits } = matchCapability(toSearchable(name.toLowerCase()), toSearchable(description.toLowerCase()), terms);
    return hits > 0 || terms.length === 0 ? [{ name, description, inputSchema, hits, nameHits }] : [];
  });
  matched.sort((left, right) => right.hits - left.hits || right.nameHits - left.nameHits);
  const authType = remoteAuthType(target.connection);
  return {
    id: target.id, name: target.name, protocol: target.protocol, transport: target.connection.transport, enabled: target.enabled,
    ...(authType !== undefined ? { authType } : {}),
    description: excerpt(target.description, searchSummaryLimits.targetDescription),
    capabilityCount: target.capabilities.length,
    matchedCapabilities: matched.slice(0, searchSummaryLimits.matchedCapabilities).map(({ name, description, inputSchema }) => ({
      name, description: excerpt(description, searchSummaryLimits.capabilityDescription), ...(inputs ? describeInputs(inputSchema) : {}),
    })),
  };
}

/** Preview top-level requirements without copying schemas, defaults, or example values. */
function describeInputs(schema: TargetDefinition["capabilities"][number]["inputSchema"]) {
  if (!schema || ["$ref", "allOf", "anyOf", "oneOf", "if", "dependentRequired", "dependentSchemas"].some((key) => Object.hasOwn(schema, key))) {
    return { requiredInputs: null };
  }
  const names = Array.isArray(schema.required) ? [...new Set(schema.required.filter((name): name is string => typeof name === "string"))] : [];
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
  const types = ["array", "boolean", "integer", "null", "number", "object", "string"];
  return { requiredInputCount: names.length, requiredInputs: names.slice(0, 12).map((name) => {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    const type = property && typeof property === "object" && "type" in property ? property.type : null;
    return { name: excerpt(name, 120), type: typeof type === "string" && types.includes(type) ? type : null };
  }) };
}

function explainTarget(target: Target, query: SearchQuery) {
  const fields = [["id", target.id], ["name", target.name], ["description", target.description],
    ...target.tags.map((tag) => ["tag", tag]), ...(target.aliases ?? []).map((name) => ["alias", name]),
    ...target.capabilities.flatMap((capability) => [["capability name", capability.name], ["capability description", capability.description]])];
  const searchable = fields.map(([field, value]) => [field!, query.toSearchable(value!.toLowerCase())] as const);
  return { id: target.id, terms: query.terms.slice(0, 50).map((term) => ({ term,
    fields: [...new Set(searchable.filter(([, value]) => value.includes(term)).map(([field]) => field))] })) };
}

interface SearchQuery {
  literal: string;
  normalized: string;
  terms: string[];
  toSearchable: (literal: string) => string;
  suggest: boolean;
}

interface RankedTarget {
  id: string;
  exact: number;
  normalizedExact: number;
  completeCapability: boolean;
  score: number;
  missingTerm?: string;
}

interface SearchPage {
  total: number;
  items: Target[];
  suggestions: { target: Target; missingTerm: string }[];
  freshness?: NonNullable<SearchResult["freshness"]>;
  exclusions?: Record<string, number>;
}

/** Rank a definition using only its searchable metadata. */
function rankTarget(target: SearchMetadata, query: SearchQuery): RankedTarget | undefined {
  const { terms, literal, normalized, toSearchable, suggest } = query;
  if (terms.length === 0) {
    return { id: target.id, exact: 0, normalizedExact: 0, completeCapability: false, score: 0 };
  }
  const fields = [
    { text: target.id, weight: 12, priority: 3 },
    { text: target.name, weight: 10, priority: 2 },
    { text: target.description, weight: 3, priority: 0 },
    ...target.tags.map((label) => ({ text: label, weight: 8, priority: 0 })),
    ...(target.aliases ?? []).map((text) => ({ text, weight: 7, priority: 0 })),
  ];
  const scores = terms.map(() => 0);
  let exact = 0;
  let normalizedExact = 0;
  /** Match a field and retain the strongest whole-query priorities for this target. */
  function rankField(text: string, priority: number): string {
    const lower = text.toLowerCase();
    const searchable = toSearchable(lower);
    if (lower === literal) {
      exact = Math.max(exact, priority);
    }
    if (normalized && searchable === normalized) {
      normalizedExact = Math.max(normalizedExact, priority);
    }
    return searchable;
  }
  for (const { text, weight, priority } of fields) {
    const searchable = rankField(text, priority);
    terms.forEach((term, index) => {
      if (searchable.includes(term)) {
        scores[index] = scores[index]! + weight;
      }
    });
  }
  let bestCapabilityCoverage = 0;
  for (const { name, description } of target.capabilities) {
    const { hits } = matchCapability(rankField(name, 1), toSearchable(description.toLowerCase()), terms, scores);
    bestCapabilityCoverage = Math.max(bestCapabilityCoverage, hits);
  }
  const missingIndex = scores.indexOf(0);
  if (missingIndex !== -1 && (!suggest || scores.indexOf(0, missingIndex + 1) !== -1)) {
    return undefined;
  }
  const matchedTerms = terms.length - Number(missingIndex !== -1);
  return { id: target.id, exact, normalizedExact, score: scores.reduce((total, score) => total + score, 0),
    completeCapability: matchedTerms > 1 && bestCapabilityCoverage === matchedTerms,
    ...(missingIndex !== -1 ? { missingTerm: terms[missingIndex]! } : {}) };
}

/** Prefer exact and single-capability matches, with a stable order for ties. */
function compareRankedTargets(left: RankedTarget, right: RankedTarget): number {
  return right.exact - left.exact || right.normalizedExact - left.normalizedExact
    || Number(right.completeCapability) - Number(left.completeCapability) || right.score - left.score
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** Build SQL predicates for filters already stored in registry columns. */
function filterSearchRows(options: DiscoverySearchOptions, alias = "") {
  const predicates: string[] = [];
  if (!options.includeDisabled) {
    predicates.push(alias + "enabled = 1");
  }
  if (options.protocol !== undefined) {
    predicates.push(alias + "protocol = ?");
  }
  return { where: predicates.length ? "WHERE " + predicates.join(" AND ") : "",
    parameters: options.protocol !== undefined ? [options.protocol] : [] };
}

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
      createSearchIndex(this.database);
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

  /** Read selected definitions from one SQLite statement, in the caller's requested order. */
  getMany(ids: string[]): TargetLookupResult {
    const found = new Map<string, Target>();
    let definitionBytes = 0;
    for (const row of this.rowsById(ids)) {
      definitionBytes += Buffer.byteLength(String(row.definition), "utf8");
      if (definitionBytes > targetLookupLimits.definitionBytes) {
        throw new HubError(413, "TARGET_LOOKUP_TOO_LARGE", "The selected definitions exceed 4 MiB. Use smaller groups or retrieve individual targets.");
      }
      found.set(String(row.id), this.readRow(row));
    }
    return { items: ids.map((id) => ({ id, target: found.get(id) ?? null })) };
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
  search(options: SearchOptions): SearchResult;
  search(options: DiscoverySearchOptions & { view: "summary" }): SearchSummaryResult;
  search(options: DiscoverySearchOptions): DiscoverySearchResult;
  search(options: DiscoverySearchOptions): DiscoverySearchResult {
    if (options.cursor === undefined) return this.searchPage(options, Date.now());
    this.database.exec("BEGIN DEFERRED");
    try {
      const continuation = searchContinuation(this.database, options);
      const result = this.searchPage({ ...options, offset: continuation.offset }, continuation.now);
      this.database.exec("COMMIT");
      return { ...result, nextCursor: continuation.nextCursor(result.total) };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private searchPage(options: DiscoverySearchOptions, now: number): DiscoverySearchResult {
    const literal = options.q.toLowerCase();
    const normalized = options.match === "normalized" ? normalizeSearchText(literal) : "";
    const terms = [...new Set((normalized || literal).split(/\s+/u).filter(Boolean))];
    const toSearchable = normalized ? normalizeSearchText : (text: string) => text;
    const suggest = options.suggest === true && options.offset === 0 && terms.length >= 3;
    const query = { literal, normalized, terms, toSearchable, suggest };
    const { total, items, suggestions, freshness, exclusions } = terms.length === 0 && !options.tag
      && options.transport === undefined && options.auth === undefined && !options.freshness && !options.withFreshness && !options.explain
      ? this.browsePage(options) : this.rankedPage(options, query, now);
    const pagination = { total, limit: options.limit, offset: options.offset,
      ...(freshness ? { freshness } : {}), ...(exclusions ? { exclusions } : {}),
      ...(options.explain ? { explanations: [...items, ...suggestions.map(({ target }) => target)].map((target) => explainTarget(target, query)) } : {}),
      ...(options.suggest ? { suggestions: suggestions.map(({ target, missingTerm }) => ({
        ...summarizeTarget(target, query, options.inputs), missingTerm,
      })) } : {}) };
    if (options.view === "summary") {
      return { view: "summary", ...pagination, items: items.map((target) => summarizeTarget(target, query, options.inputs)) };
    }
    return { items, ...pagination };
  }

  /** Let SQLite return only an unranked page and retain the count even for an empty page. */
  private browsePage(options: DiscoverySearchOptions): SearchPage {
    const { where, parameters } = filterSearchRows(options);
    const rows = this.database.prepare(`
      SELECT page.definition, page.created_at, page.updated_at, totals.total
      FROM (SELECT COUNT(*) AS total FROM targets ${where}) AS totals
      LEFT JOIN (
        SELECT id, definition, created_at, updated_at FROM targets ${where}
        ORDER BY id LIMIT ? OFFSET ?
      ) AS page ON 1
      ORDER BY page.id
    `).all(...parameters, ...parameters, options.limit, options.offset);
    return { total: Number(rows[0]!.total), items: rows.filter((row) => row.definition !== null).map((row) => this.readRow(row)), suggestions: [] };
  }

  /** Hold compact scores while reading the selected definitions from the same SQLite snapshot. */
  private rankedPage(options: DiscoverySearchOptions, query: SearchQuery, now: number): SearchPage {
    const { where, parameters } = options.explain ? { where: "", parameters: [] } : filterSearchRows(options, "t.");
    const tag = options.tag?.toLowerCase();
    const needsObservation = Boolean(options.freshness || options.withFreshness);
    const observationFields = "t.revision, o.revision AS observed_revision, o.checked_at, o.status";
    const observationJoin = "LEFT JOIN metadata_observations o ON o.target_id = t.id";
    const ownTransaction = !this.database.isTransaction;
    if (ownTransaction) this.database.exec("BEGIN DEFERRED");
    try {
      const matches: RankedTarget[] = [];
      const partialMatches: RankedTarget[] = [];
      const exclusions: Record<string, number> = {};
      const suggestionLimit = Math.min(options.limit, searchSuggestionLimit);
      for (const row of this.database.prepare(`SELECT s.metadata, t.protocol, t.enabled ${options.freshness ? ", " + observationFields : ""}
        FROM target_search s JOIN targets t ON t.id = s.id ${options.freshness ? observationJoin : ""} ${where}`).iterate(...parameters)) {
        const target = JSON.parse(String(row.metadata)) as SearchMetadata;
        const excluded = [
          !options.includeDisabled && !row.enabled ? "disabled" : undefined,
          options.protocol && options.protocol !== row.protocol ? "protocol" : undefined,
          options.transport && options.transport !== target.connection.transport ? "transport" : undefined,
          options.auth && options.auth !== remoteAuthType(target.connection) ? "auth" : undefined,
          tag && !target.tags.some((label) => label.toLowerCase() === tag) ? "tag" : undefined,
          options.freshness && options.freshness !== observedFreshness(row, now, options.staleHours ?? 24).state ? "freshness" : undefined,
        ].filter((reason): reason is string => reason !== undefined);
        if (excluded.length && !options.explain) continue;
        const ranked = rankTarget(target, query);
        if (!ranked) {
          continue;
        }
        if (excluded.length) {
          if (ranked.missingTerm === undefined) for (const reason of excluded) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
          continue;
        }
        if (ranked.missingTerm === undefined) {
          matches.push(ranked);
        } else if (matches.length === 0) {
          partialMatches.push(ranked);
          partialMatches.sort(compareRankedTargets);
          if (partialMatches.length > suggestionLimit) {
            partialMatches.pop();
          }
        }
      }

      matches.sort(compareRankedTargets);
      const ids = matches.slice(options.offset, options.offset + options.limit).map(({ id }) => id);
      const suggested = matches.length === 0 ? partialMatches : [];
      const pageIds = [...ids, ...suggested.map(({ id }) => id)];
      const found = new Map<string, Target>();
      if (pageIds.length) {
        for (const row of this.rowsById(pageIds)) {
          found.set(String(row.id), this.readRow(row));
        }
      }
      const items = ids.map((id) => found.get(id)!);
      const suggestions = suggested.map(({ id, missingTerm }) => ({ target: found.get(id)!, missingTerm: missingTerm! }));
      const metadata = needsObservation && pageIds.length ? this.database.prepare(`SELECT t.id, ${observationFields} FROM targets t
        ${observationJoin} WHERE t.id IN (${pageIds.map(() => "?").join(",")})`).all(...pageIds) : [];
      const byId = new Map(metadata.map((row) => [String(row.id), observedFreshness(row, now, options.staleHours ?? 24)]));
      if (ownTransaction) this.database.exec("COMMIT");
      return { total: matches.length, items, suggestions,
        ...(needsObservation ? { freshness: pageIds.map((id) => ({ id, ...byId.get(id)! })) } : {}),
        ...(options.explain && matches.length === 0 ? { exclusions } : {}) };
    } catch (error) {
      if (ownTransaction && this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /** Read complete rows for an explicit group without relying on SQLite result order. */
  private rowsById(ids: string[]) {
    const placeholders = ids.map(() => "?").join(", ");
    return this.database.prepare(`SELECT id, definition, created_at, updated_at FROM targets WHERE id IN (${placeholders})`).iterate(...ids);
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
