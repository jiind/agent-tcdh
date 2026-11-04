import { isDeepStrictEqual } from "node:util";
import type { HubClient } from "../client.js";
import type { TargetDefinition } from "../targets/schema.js";
import { searchResultSchema, searchSchema, targetDefinitionSchema } from "../targets/schema.js";
import { importOptionsSchema, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_TARGETS, parseSnapshot, serializeSnapshot } from "./schema.js";
import type { RegistrySnapshot } from "./schema.js";

const fields = ["name", "description", "protocol", "tags", "capabilities", "connection", "enabled"] as const;
type DiffStatus = "added" | "changed" | "unchanged" | "retained";
export interface DiffEntry {
  id: string;
  status: DiffStatus;
  fields: (typeof fields)[number][];
  current?: TargetDefinition | null;
  incoming?: TargetDefinition | null;
}

/** Compare bounded portable definitions and explain the existing import policy without writing anything. */
export function diffSnapshots(incomingInput: RegistrySnapshot, currentInput: RegistrySnapshot,
  options: { onConflict?: string | undefined; details?: boolean | undefined } = {}) {
  // 1. Reuse snapshot validation and compare JSON values without treating object key order as a change.
  const incoming = parseSnapshot(incomingInput);
  const current = parseSnapshot(currentInput);
  serializeSnapshot(incoming);
  serializeSnapshot(current);
  const policy = importOptionsSchema.parse({ onConflict: options.onConflict });
  const source = new Map(incoming.targets.map((target) => [target.id, target]));
  const destination = new Map(current.targets.map((target) => [target.id, target]));
  const ids = [...new Set([...source.keys(), ...destination.keys()])].sort();
  const counts = { incoming: source.size, current: destination.size, added: 0, changed: 0, unchanged: 0, retained: 0 };
  const entries: DiffEntry[] = [];
  for (const id of ids) {
    const next = source.get(id);
    const previous = destination.get(id);
    const changed = next && previous ? fields.filter((field) => !isDeepStrictEqual(previous[field], next[field])) : [];
    const status: DiffStatus = !next ? "retained" : !previous ? "added" : changed.length ? "changed" : "unchanged";
    counts[status]++;
    entries.push({ id, status, fields: changed,
      ...(options.details ? { current: previous ?? null, incoming: next ?? null } : {}) });
  }

  // 2. Existing IDs conflict even when definitions are identical; replacements still create new revisions.
  const overlaps = counts.changed + counts.unchanged;
  const conflicts = policy.onConflict === "error" ? overlaps : 0;
  return { comparedAt: new Date().toISOString(), sourceExportedAt: incoming.exportedAt,
    onConflict: policy.onConflict, importReady: conflicts === 0, conflicts, counts, entries,
    expectedImport: conflicts ? null : { inserted: counts.added,
      replaced: policy.onConflict === "replace" ? overlaps : 0, skipped: policy.onConflict === "skip" ? overlaps : 0 },
    applied: false, executionVerified: false };
}

/** Read all registered definitions through bounded read-only discovery pages, including disabled entries. */
async function readDefinitions(client: Pick<HubClient, "search">): Promise<RegistrySnapshot> {
  // 1. Detect incomplete/changing pages and enforce existing snapshot count/size limits before returning a result.
  const targets: TargetDefinition[] = [];
  const ids = new Set<string>();
  let expected = 0;
  let bytes = 0;
  for (let offset = 0; ; offset += 100) {
    const page = searchResultSchema.parse(await client.search(searchSchema.parse({ includeDisabled: true, limit: 100, offset })));
    if (offset === 0) {
      expected = page.total;
    }
    if (page.total > MAX_SNAPSHOT_TARGETS) {
      throw new Error("Registry comparison supports at most 10000 current targets.");
    }
    if (page.total !== expected || page.items.length !== Math.min(100, expected - offset)
      || new Set(page.items.map((target) => target.id)).size !== page.items.length || page.items.some((target) => ids.has(target.id))) {
      throw new Error("Discovery pages changed or were incomplete. Retry comparison against a stable registry.");
    }
    for (const target of page.items) {
      const portable = targetDefinitionSchema.parse({ id: target.id, name: target.name, description: target.description,
        protocol: target.protocol, tags: target.tags, enabled: target.enabled, capabilities: target.capabilities, connection: target.connection });
      bytes += Buffer.byteLength(JSON.stringify(portable), "utf8");
      if (bytes > MAX_SNAPSHOT_BYTES) {
        throw new Error("Registry comparison definitions exceed the 16 MiB snapshot limit.");
      }
      ids.add(target.id);
      targets.push(portable);
    }
    if (targets.length === expected) {
      break;
    }
  }

  // 2. Validate the complete collection; pagination observes current metadata rather than a transactional snapshot.
  const snapshot = parseSnapshot({ format: "agent-tcdh", version: 1, exportedAt: new Date().toISOString(), targets });
  serializeSnapshot(snapshot);
  return snapshot;
}

/** Compare an explicit incoming snapshot with current hub metadata, without provider calls or import requests. */
export async function compareRegistry(client: Pick<HubClient, "search">, input: RegistrySnapshot,
  options: { onConflict?: string | undefined; details?: boolean | undefined } = {}) {
  // 1. Reject invalid inputs and policies before reading hub data.
  const incoming = parseSnapshot(input);
  serializeSnapshot(incoming);
  importOptionsSchema.parse({ onConflict: options.onConflict });

  // 2. Produce an advisory comparison from read-only discovery, never a promise about a later import.
  return { ...diffSnapshots(incoming, await readDefinitions(client), options), consistency: "paginated-observation" as const };
}

/** Render field names and policy effects without printing full registered definitions to the terminal. */
export function formatComparison(report: ReturnType<typeof diffSnapshots>): string {
  return "Comparison: " + report.counts.added + " added, " + report.counts.changed + " changed, "
    + report.counts.unchanged + " unchanged, " + report.counts.retained + " retained.\n"
    + report.entries.map((entry) => entry.status.toUpperCase() + " " + entry.id
      + (entry.fields.length ? ": " + entry.fields.join(", ") : "")).join("\n")
    + "\nImport policy: " + report.onConflict + (report.importReady ? "; expected counts: " + JSON.stringify(report.expectedImport)
      : "; blocked by " + report.conflicts + " existing ids. Choose --on-conflict skip/replace or different ids.")
    + "\nRead-only comparison; no registry changes. A later import rechecks its own conflicts.";
}
