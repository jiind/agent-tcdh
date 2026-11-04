import { isDeepStrictEqual } from "node:util";
import type { HubClient } from "../client.js";
import { targetDefinitionSchema, targetSchema, type TargetDefinition } from "../targets/schema.js";
import type { VersionedTarget } from "../targets/version.js";
import { preparedSnapshot } from "./import-config.js";
import { definitionHashes, importFields, type ImportBinding, type ImportField, type ImportProfile } from "./import-profiles.js";
import type { prepareLocalImport } from "./local-import.js";

export type LocalPreparation = Awaited<ReturnType<typeof prepareLocalImport>>;
type SyncClient = Pick<HubClient, "getVersioned" | "importRegistry" | "update" | "remove">;
type SyncAction = "added" | "updated" | "unchanged" | "retained" | "removed" | "forgotten" | "conflict";
export interface SyncItem {
  id: string;
  action: SyncAction;
  origins: string[];
  fields: ImportField[];
  hubModifiedFields: ImportField[];
  issue?: string;
  version?: string;
}
interface Planned extends SyncItem {
  incoming?: TargetDefinition;
  binding?: ImportBinding;
  sourceHashes?: ImportBinding["sourceHashes"];
  acceptedFields?: ImportField[];
}
export interface SyncPlan {
  ready: boolean;
  items: SyncItem[];
  counts: Record<SyncAction, number>;
  operations: Planned[];
}

/** Read a target without conflating authentication/server failures with a genuinely missing registration. */
async function currentTarget(client: SyncClient, id: string): Promise<VersionedTarget | undefined> {
  try {
    const current = await client.getVersioned(id);
    const target = targetSchema.parse(current.target);
    if (target.id !== id) {
      throw new Error("The registry returned a different target ID.");
    }
    return { target, etag: current.etag };
  } catch (error) {
    if (error instanceof Error && /^HTTP 404\b/u.test(error.message)) {
      return undefined;
    }
    throw new Error("Unable to read every managed registration; no synchronization changes were started.");
  }
}

/** Expose action/field metadata while retaining full conditional proposals only within this CLI process. */
function summary(operations: Planned[]): SyncPlan {
  const counts = { added: 0, updated: 0, unchanged: 0, retained: 0, removed: 0, forgotten: 0, conflict: 0 };
  for (const item of operations) {
    counts[item.action]++;
  }
  const items = operations.map(({ incoming: _incoming, binding: _binding, sourceHashes: _sourceHashes, acceptedFields: _acceptedFields, ...item }) => item);
  return { ready: counts.conflict === 0, counts, items, operations };
}

/** Compare tracked source fields with current registrations, preserve hub-only edits, and plan optional guarded pruning. */
export async function planImportSync(client: SyncClient, profile: ImportProfile, preparation: LocalPreparation, prune = false): Promise<SyncPlan> {
  // 1. Reject invalid selected declarations and unreadable tracked origins before any registry writes.
  const unavailable = preparation.sources.filter((source) => source.status === "error");
  const trackedUnavailable = profile.bindings.some((binding) => binding.origins.some((key) => unavailable.some((source) =>
    key.startsWith(source.id + "/") || source.kind === "a2a" && key.startsWith(source.id + "-"))));
  if (trackedUnavailable || preparation.issues.some((issue) => issue.severity === "error")
    || preparation.entries.some((entry) => entry.selected && entry.status === "blocked")) {
    return summary([{ id: "source", origins: [], action: "conflict", fields: [], hubModifiedFields: [], issue: "SOURCE_UNAVAILABLE" }]);
  }
  const operations: Planned[] = [];
  const used = new Set<string>();

  // 2. Match all coalesced origins to existing IDs and perform a field-level three-way comparison.
  for (const raw of preparation.targets) {
    const origins = preparation.entries.filter((entry) => entry.selected && entry.targetId === raw.id).map((entry) => entry.key);
    const previous = profile.bindings.find((binding) => !used.has(binding.id) && binding.origins.some((key) => origins.includes(key)));
    const id = previous?.id ?? raw.id;
    const incoming = targetDefinitionSchema.parse({ ...raw, id });
    if (used.has(id)) {
      operations.push({ id, origins, action: "conflict", fields: [], hubModifiedFields: [], issue: "SOURCE_ID_COLLISION" });
      continue;
    }
    used.add(id);
    const current = await currentTarget(client, id);
    if (!previous) {
      operations.push({ id, origins, action: current ? "conflict" : "added", fields: [], hubModifiedFields: [], incoming,
        sourceHashes: definitionHashes(incoming), ...(current ? { issue: "ID_ALREADY_EXISTS" } : {}) });
      continue;
    }
    if (!current) {
      operations.push({ id, origins, action: "conflict", fields: [], hubModifiedFields: [], binding: previous, issue: "MANAGED_TARGET_MISSING" });
      continue;
    }
    const nextHashes = definitionHashes(incoming);
    const currentHashes = definitionHashes(current.target);
    const changed = importFields.filter((field) => nextHashes[field] !== previous.sourceHashes[field]);
    const hubModified = importFields.filter((field) => currentHashes[field] !== previous.destinationHashes[field]);
    const conflicts = changed.filter((field) => hubModified.includes(field) && currentHashes[field] !== nextHashes[field]);
    if (conflicts.length) {
      operations.push({ id, origins, action: "conflict", fields: conflicts, hubModifiedFields: hubModified, binding: previous,
        version: current.etag, issue: "SOURCE_AND_HUB_CHANGED" });
      continue;
    }
    const merged: Record<string, unknown> = { ...current.target };
    for (const field of changed) {
      merged[field] = incoming[field];
    }
    const acceptedFields = [...changed];
    if (changed.includes("connection") && incoming.protocol === "mcp") {
      if (hubModified.includes("capabilities")) {
        operations.push({ id, origins, action: "conflict", fields: ["capabilities"], hubModifiedFields: hubModified, binding: previous,
          version: current.etag, issue: "CONNECTION_AND_METADATA_CHANGED" });
        continue;
      }
      merged.capabilities = incoming.capabilities;
      acceptedFields.push("capabilities");
    }
    const target = targetDefinitionSchema.parse({ id, name: merged.name, description: merged.description, protocol: merged.protocol,
      connection: merged.connection, capabilities: merged.capabilities, tags: merged.tags, enabled: merged.enabled });
    const fields = importFields.filter((field) => !isDeepStrictEqual(current.target[field], target[field]));
    operations.push({ id, origins, action: fields.length ? "updated" : "unchanged", fields, hubModifiedFields: hubModified,
      incoming: target, binding: previous, sourceHashes: nextHashes, acceptedFields, version: current.etag });
  }

  // 3. Retain disappeared sources by default; prune only unchanged managed definitions with a current version condition.
  for (const binding of profile.bindings.filter((item) => !used.has(item.id))) {
    const current = await currentTarget(client, binding.id);
    const hashes = current ? definitionHashes(current.target) : undefined;
    const modified = hashes ? importFields.filter((field) => field !== "capabilities" && hashes[field] !== binding.destinationHashes[field]) : [];
    operations.push({ id: binding.id, origins: binding.origins, binding, fields: [], hubModifiedFields: modified,
      action: !current ? "forgotten" : !prune ? "retained" : modified.length ? "conflict" : "removed",
      ...(current ? { version: current.etag } : {}), ...(prune && modified.length ? { issue: "ORPHAN_CHANGED_IN_HUB" } : {}) });
  }
  return summary(operations);
}

/** Apply a fully reviewed sync plan with independent conditional writes and keep a ledger only for successful outcomes. */
export async function applyImportSync(client: SyncClient, profile: ImportProfile, plan: SyncPlan,
  checkpoint?: (bindings: ImportBinding[]) => Promise<void>) {
  const outcomes: { id: string; status: "applied" | "unchanged" | "retained" | "failed"; issue?: string }[] = [];
  const bindings = new Map(profile.bindings.map((binding) => [binding.id, binding]));
  if (!plan.ready) {
    return { applied: false, failed: true, outcomes, bindings: profile.bindings };
  }
  const additions = plan.operations.filter((item) => item.action === "added");
  if (additions.length) {
    let added = false;
    try {
      await client.importRegistry(preparedSnapshot(additions.map((item) => item.incoming!)), { onConflict: "error", dryRun: false });
      for (const item of additions) {
        bindings.set(item.id, { id: item.id, origins: item.origins, sourceHashes: item.sourceHashes!, destinationHashes: definitionHashes(item.incoming!) });
        outcomes.push({ id: item.id, status: "applied" });
      }
      added = true;
    } catch {
      additions.forEach((item) => outcomes.push({ id: item.id, status: "failed", issue: "CONDITIONAL_SYNC_FAILED" }));
    }
    if (added && checkpoint) {
      await checkpoint([...bindings.values()]);
    }
  }
  for (const item of plan.operations.filter((operation) => operation.action !== "added")) {
    try {
      if (item.action === "updated") {
        await client.update(item.id, item.incoming!, item.version);
      } else if (item.action === "removed") {
        await client.remove(item.id, item.version);
      }
      if (item.action === "removed" || item.action === "forgotten") {
        bindings.delete(item.id);
      } else if (item.action !== "retained") {
        const hashes = definitionHashes(item.incoming!);
        const destinationHashes = item.binding ? { ...item.binding.destinationHashes } : hashes;
        for (const field of item.acceptedFields ?? importFields) {
          destinationHashes[field] = hashes[field];
        }
        bindings.set(item.id, { id: item.id, origins: item.origins, sourceHashes: item.sourceHashes!, destinationHashes });
      }
      outcomes.push({ id: item.id, status: item.action === "retained" ? "retained" : item.action === "unchanged" ? "unchanged" : "applied" });
    } catch {
      outcomes.push({ id: item.id, status: "failed", issue: "CONDITIONAL_SYNC_FAILED" });
    }
  }
  return { applied: true, failed: outcomes.some((item) => item.status === "failed"), outcomes, bindings: [...bindings.values()] };
}
