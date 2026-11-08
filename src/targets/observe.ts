import type { HubClient } from "../client.js";
import { followUpImport } from "../onboarding/import-follow-up.js";
import { batchTargetOptionsSchema, selectBatchTargets, type BatchTargetOptions } from "./batch.js";
import { freshnessQuerySchema } from "../registry/activity.js";

/** Select stale/failed/unknown metadata and record only revision-consistent consumer inspections. */
export async function observeTargets(client: HubClient, input: BatchTargetOptions, options: {
  apply?: boolean | undefined; staleOnly?: boolean | undefined; staleHours?: number | undefined;
  inspectStdio?: boolean | undefined; stdioCwd?: string | undefined; refresh?: boolean | undefined;
}, environment = process.env) {
  // 1. Resolve the complete selection and observation state before allowing provider activity.
  const selection = await selectBatchTargets(client, batchTargetOptionsSchema.parse(input));
  const outcomes: { id: string; status: string; recorded: boolean; issue?: string | undefined }[] = [];
  if (selection.issue) {
    return { ready: false, applied: false, outcomes, issue: selection.issue, failed: true, executionVerified: false };
  }
  const staleHours = freshnessQuerySchema.shape.staleHours.parse(options.staleHours);
  const states = new Map<string, { state: string; status: unknown }>();
  if (options.staleOnly) {
    for (let offset = 0; offset < 10000; offset += 1000) {
      const page = await client.freshness({ staleHours, limit: 1000, offset });
      for (const item of page.items) {
        states.set(item.id, item);
      }
      if (offset + page.items.length >= page.total) {
        break;
      }
      if (offset === 9000) {
        throw new Error("Freshness filtering supports at most 10000 registrations. Narrow the registry.");
      }
    }
  }
  const selected = selection.targets.filter((target) => !options.staleOnly || states.get(target.id)?.state !== "fresh"
    || ["failed", "warning", "skipped"].includes(String(states.get(target.id)?.status)));
  // 2. Inspect in the consumer process and never overwrite an observation for a changed definition.
  for (const target of selected) {
    if (!options.apply) {
      outcomes.push({ id: target.id, status: "planned", recorded: false });
      continue;
    }
    try {
      const before = await client.getVersioned(target.id);
      let observedVersion = before.etag;
      const inspection = await followUpImport({
        /** Reject any definition change since selection of this inspection's initial version. */
        getVersioned: async (id) => {
          const current = await client.getVersioned(id);
          if (current.etag !== observedVersion) {
            throw new Error("The definition changed during inspection.");
          }
          return current;
        },
        /** Retain the committed version without mistaking a later reread for the inspected result. */
        update: async (id, definition, etag) => {
          const updated = await client.updateVersioned(id, definition, etag!);
          observedVersion = updated.etag;
          return updated.target;
        },
      }, [target.id], { diagnose: true, refresh: options.refresh, inspectStdio: options.inspectStdio,
        stdioCwd: options.stdioCwd }, environment);
      const result = inspection.outcomes[0]!;
      const status = result.diagnosis === "drift" ? "warning" : result.status;
      if (result.status === "skipped") {
        outcomes.push({ id: target.id, status: "skipped", recorded: false, issue: result.issue });
      } else {
        await client.observe(target.id, { status, scope: "metadata", executionVerified: false }, observedVersion);
        outcomes.push({ id: target.id, status, recorded: true });
      }
      if (inspection.cancelled) {
        outcomes.push(...selected.slice(outcomes.length).map((item) => ({ id: item.id, status: "skipped", recorded: false, issue: "INSPECTION_CANCELLED" })));
        break;
      }
    } catch {
      outcomes.push({ id: target.id, status: "failed", recorded: false, issue: "INSPECTION_OR_RECORDING_FAILED" });
    }
  }
  return { ready: true, applied: Boolean(options.apply), outcomes, failed: outcomes.some((item) => item.status === "failed"), executionVerified: false };
}
