import { isDeepStrictEqual } from "node:util";
import type { HubClient } from "../client.js";
import { batchTargetOptionsSchema, selectBatchTargets } from "../targets/batch.js";
import { targetIdSchema, type Target } from "../targets/schema.js";

/** Compare only compatible connection identity; labels and observed capability lists remain reviewable differences. */
function sameConnection(left: Target, right: Target): boolean {
  return left.protocol === right.protocol && left.enabled === right.enabled && isDeepStrictEqual(left.connection, right.connection);
}

/** Preview registry-wide duplicates or conditionally remove an explicitly selected redundant group without merging metadata. */
export async function manageDuplicates(client: Pick<HubClient, "search" | "getVersioned" | "remove">,
  options: { limit?: number | undefined; keep?: string | undefined; remove?: string[] | undefined; apply?: boolean | undefined }) {
  // 1. Require an explicit representative and unique removal IDs before resolving any cleanup group.
  if (Boolean(options.keep) !== Boolean(options.remove?.length) || options.apply && !options.keep
    || options.remove && (options.remove.length > 100 || new Set(options.remove).size !== options.remove.length || options.remove.includes(options.keep ?? ""))) {
    throw new Error("Cleanup requires --keep ID and between 1 and 100 distinct --remove IDs. The representative cannot be removed.");
  }
  if (options.keep) {
    targetIdSchema.parse(options.keep);
    options.remove!.forEach((id) => targetIdSchema.parse(id));
  }
  const selection = await selectBatchTargets(client, batchTargetOptionsSchema.parse({ includeDisabled: true, limit: options.limit ?? 1000,
    ...(options.keep ? { select: [options.keep, ...options.remove!] } : {}) }));
  if (selection.issue) {
    return { ready: false, applied: false, groups: [], outcomes: [], issue: selection.issue.code, executionVerified: false as const };
  }
  const groups: { ids: string[]; protocol: string; transport: string; differingFields: string[] }[] = [];
  const grouped = new Map<string, Target[]>();
  for (const target of selection.targets) {
    const signature = JSON.stringify({ protocol: target.protocol, enabled: target.enabled, connection: target.connection },
      (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value);
    const group = grouped.get(signature) ?? [];
    group.push(target);
    grouped.set(signature, group);
  }
  for (const group of grouped.values()) {
    if (group.length < 2) {
      continue;
    }
    const [representative, ...members] = group as [Target, ...Target[]];
    const ids = group.map((target) => target.id);
    groups.push({ ids, protocol: representative.protocol, transport: representative.connection.transport,
      differingFields: (["name", "description", "tags", "capabilities"] as const).filter((field) => members.some((target) => !isDeepStrictEqual(target[field], representative[field]))) });
  }

  // 2. Pin the complete explicit group to fresh versions; a mismatch blocks every deletion.
  const outcomes: { id: string; status: "removed" | "failed"; issue?: string }[] = [];
  let ready = !options.keep || groups.some((group) => group.ids.includes(options.keep!) && options.remove!.every((id) => group.ids.includes(id)));
  if (!ready || !options.apply) {
    return { ready, applied: false, groups, outcomes, ...(ready ? {} : { issue: "NOT_IDENTICAL_CONNECTIONS" }), executionVerified: false as const };
  }
  const keep = await client.getVersioned(options.keep!);
  const removals = [];
  for (const id of options.remove!) {
    const item = await client.getVersioned(id);
    if (!sameConnection(keep.target, item.target)) {
      ready = false;
    }
    removals.push({ id, version: item.etag });
  }
  if (!ready) {
    return { ready: false, applied: false, groups, outcomes, issue: "CONNECTION_CHANGED", executionVerified: false as const };
  }

  // 3. Recheck the representative before each independent version-guarded removal and retain partial outcomes.
  for (const item of removals) {
    try {
      if ((await client.getVersioned(options.keep!)).etag !== keep.etag) {
        throw new Error("The representative changed.");
      }
      await client.remove(item.id, item.version);
      outcomes.push({ id: item.id, status: "removed" });
    } catch {
      outcomes.push({ id: item.id, status: "failed", issue: "CONDITIONAL_REMOVAL_FAILED" });
      break;
    }
  }
  return { ready: outcomes.length === removals.length && outcomes.every((item) => item.status === "removed"),
    applied: true, groups, outcomes, executionVerified: false as const };
}
