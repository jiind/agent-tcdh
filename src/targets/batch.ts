import { z } from "zod";
import type { HubClient } from "../client.js";
import { searchResultSchema, searchSchema, targetIdSchema, targetSchema, type Target } from "./schema.js";

export const batchTargetOptionsSchema = z.strictObject({
  select: z.array(targetIdSchema).min(1).max(1000).optional(),
  q: searchSchema.shape.q,
  protocol: searchSchema.shape.protocol,
  tag: searchSchema.shape.tag,
  includeDisabled: searchSchema.shape.includeDisabled,
  limit: z.number().int().min(1).max(1000).default(100),
  concurrency: z.number().int().min(1).max(8).default(3),
}).superRefine((options, context) => {
  if (options.select && new Set(options.select).size !== options.select.length) {
    context.addIssue({ code: "custom", path: ["select"], message: "Selected target IDs must be unique." });
  }
  if (options.select && (options.q || options.protocol || options.tag)) {
    context.addIssue({ code: "custom", path: ["select"], message: "Choose explicit target IDs or discovery filters, not both." });
  }
});
export type BatchTargetOptions = z.infer<typeof batchTargetOptionsSchema>;

/** Resolve every explicit ID before allowing any provider inspection or registry write. */
async function selectExplicitTargets(client: Pick<HubClient, "getVersioned">, options: BatchTargetOptions) {
  // 1. Apply the selection cap before making any per-ID registry requests.
  const selected = options.select!;
  const targets: Target[] = [];
  let issue: { code: string; message: string } | undefined;
  if (selected.length > options.limit) {
    return { matched: selected.length, targets,
      issue: { code: "SELECTION_LIMIT_EXCEEDED", message: "Selected IDs exceed --limit; no target lookups, inspections, or updates were started." } };
  }

  // 2. Resolve the complete requested group in input order, discarding partial membership on any failure.
  for (const id of selected) {
    try {
      const current = targetSchema.parse((await client.getVersioned(id)).target);
      if (current.id !== id) {
        throw new Error("The hub returned a different target id.");
      }
      if (!current.enabled && !options.includeDisabled) {
        issue = { code: "SELECTION_TARGET_DISABLED", message: "Selected target " + id + " is disabled. Use --include-disabled to select it explicitly; no provider inspections or updates were started." };
        break;
      }
      targets.push(current);
    } catch {
      issue = { code: "SELECTION_TARGET_UNAVAILABLE", message: "Unable to read selected target " + id + ". Check the ID and read access; no provider inspections or updates were started." };
      break;
    }
  }
  return { matched: selected.length, targets: issue ? [] : targets, ...(issue ? { issue } : {}) };
}

/** Collect explicit IDs or bounded discovery membership before provider requests or registry updates. */
export async function selectBatchTargets(client: Pick<HubClient, "search" | "getVersioned">, input: BatchTargetOptions) {
  // 1. Validate the selector and resolve explicit IDs without enumerating discovery pages.
  const options = batchTargetOptionsSchema.parse(input);
  if (options.select) {
    return selectExplicitTargets(client, options);
  }

  // 2. Collect complete, deduplicated discovery pages with a stable observed count.
  const targets: Target[] = [];
  const ids = new Set<string>();
  let matched = 0;
  let issue: { code: string; message: string } | undefined;
  try {
    for (let offset = 0; ; offset += 100) {
      const page = searchResultSchema.parse(await client.search(searchSchema.parse({
        q: options.q, protocol: options.protocol, tag: options.tag, includeDisabled: options.includeDisabled, limit: 100, offset,
      })));
      if (offset === 0) {
        matched = page.total;
      }
      if (page.total > options.limit) {
        issue = { code: "SELECTION_LIMIT_EXCEEDED", message: "Matching targets exceed --limit; no target inspections or updates were started." };
        break;
      }
      if (page.total !== matched || page.limit !== 100 || page.offset !== offset
        || page.items.length !== Math.min(100, matched - offset)
        || new Set(page.items.map((target) => target.id)).size !== page.items.length || page.items.some((target) => ids.has(target.id))) {
        issue = { code: "SELECTION_CHANGED", message: "Discovery pages changed or were incomplete; no target inspections or updates were started. Retry against a stable registry." };
        break;
      }
      for (const target of page.items) {
        ids.add(target.id);
        targets.push(target);
      }
      if (targets.length === matched) {
        break;
      }
    }
  } catch {
    issue = { code: "DISCOVERY_FAILED", message: "Unable to read all matching targets; no target inspections or updates were started." };
  }

  // 3. Discard partial membership after any selection failure.
  return { matched, targets: issue ? [] : targets, ...(issue ? { issue } : {}) };
}
