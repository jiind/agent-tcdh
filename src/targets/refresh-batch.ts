import { isDeepStrictEqual } from "node:util";
import type { HubClient } from "../client.js";
import { refreshDefinition } from "../remote-import.js";
import { batchTargetOptionsSchema, selectBatchTargets, type BatchTargetOptions } from "./batch.js";
import { targetSchema, type Target } from "./schema.js";
import type { VersionedTarget } from "./version.js";

type Outcome = "planned" | "updated" | "unchanged" | "skipped" | "failed";
type RefreshResult = {
  id: string; protocol: Target["protocol"]; transport: Target["connection"]["transport"];
  status: Outcome; fields: string[]; baseVersion?: string;
  capabilities?: { before: number; after: number };
  issue?: { code: string; message: string };
  executionVerified: false;
};

/** Carry fixed per-target skip reasons without exposing provider metadata or errors. */
class RefreshSkip extends Error {
  /** Retain a stable code and a fixed diagnostic for an unsupported target. */
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Gate metadata access and updates using current state and each target's own authentication references. */
function validateRefreshTarget(target: Target, options: BatchTargetOptions): void {
  if (!target.enabled && !options.includeDisabled) {
    throw new RefreshSkip("TARGET_DISABLED", "The target was disabled after discovery; it was not updated.");
  }
  if (target.connection.transport === "stdio") {
    throw new RefreshSkip("STDIO_NOT_SUPPORTED", "Stdio commands are not launched. Edit the definition in the consuming environment.");
  }
  const auth = target.connection.auth;
  if (auth && !["none", "bearer"].includes(auth.type)) {
    throw new RefreshSkip("AUTH_NOT_SUPPORTED", "Use single-target refresh with an explicit Bearer reference if supported by the provider.");
  }
  if (auth?.type === "bearer" && auth.envVars.length !== 1) {
    throw new RefreshSkip("BEARER_ENV_REQUIRED", "Single-target refresh requires selecting the appropriate credential reference.");
  }
}

/** Preview or independently apply guarded metadata refreshes with bounded selection and concurrency. */
export async function refreshBatch(client: Pick<HubClient, "search" | "getVersioned" | "update">,
  input: BatchTargetOptions, apply = false, environment: NodeJS.ProcessEnv = process.env) {
  // 1. Resolve the complete target group before contacting any provider or attempting a registry update.
  const options = batchTargetOptionsSchema.parse(input);
  const selection = await selectBatchTargets(client, options);
  const summary = { planned: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const targets: RefreshResult[] = new Array(selection.targets.length);
  if (selection.issue) {
    return { status: "failed", selection: options, matched: selection.matched, complete: false,
      dryRun: !apply, applyRequested: apply, summary, targets, selectionIssue: selection.issue, executionVerified: false };
  }

  // 2. Reuse single-target refresh merging and save only changed fields against the final observed version.
  let next = 0;
  /** Process independent targets without reordering outcomes or retrying failed writes. */
  async function worker() {
    while (next < selection.targets.length) {
      const index = next++;
      const selected = selection.targets[index]!;
      const result: RefreshResult = { id: selected.id, protocol: selected.protocol, transport: selected.connection.transport,
        status: "failed", fields: [], executionVerified: false };
      const observed: { current?: VersionedTarget } = {};
      let writing = false;
      try {
        const proposal = await refreshDefinition({
          /** Validate every reread so a concurrent disable prevents a later update. */
          getVersioned: async (id) => {
            const current = await client.getVersioned(id);
            const target = targetSchema.parse(current.target);
            if (target.id !== selected.id) {
              throw new Error("The hub returned a different target id.");
            }
            result.protocol = target.protocol;
            result.transport = target.connection.transport;
            result.baseVersion = current.etag;
            validateRefreshTarget(target, options);
            observed.current = { target, etag: current.etag };
            return observed.current;
          },
        }, selected.id, undefined, {}, environment);
        if (!observed.current) {
          throw new Error("The current target was not read.");
        }
        const current = observed.current.target;
        result.fields = (["capabilities", "connection"] as const).filter((field) => !isDeepStrictEqual(current[field], proposal.target[field]));
        result.capabilities = { before: current.capabilities.length, after: proposal.target.capabilities.length };
        if (!result.fields.length) {
          result.status = "unchanged";
        } else if (!apply) {
          result.status = "planned";
        } else {
          writing = true;
          await client.update(selected.id, proposal.target, proposal.etag);
          result.status = "updated";
        }
      } catch (error) {
        if (error instanceof RefreshSkip) {
          result.status = "skipped";
          result.issue = { code: error.code, message: error.message };
        } else {
          result.issue = { code: writing && error instanceof Error && /^HTTP 412\b/u.test(error.message) ? "UPDATE_CONFLICT" : "REFRESH_FAILED",
            message: writing ? "The conditional update failed. Reread this target before retrying; other targets may have been updated."
              : "Unable to refresh this target. Review single-target metadata checks and provider credential availability." };
        }
      }
      targets[index] = result;
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, selection.targets.length) }, () => worker()));

  // 3. Expose per-target outcomes without returning full definitions, provider values, or raw error bodies.
  for (const target of targets) {
    summary[target.status]++;
  }
  return { status: summary.failed ? "failed" : summary.skipped || !targets.length ? "warning" : "passed",
    selection: options, matched: selection.matched, complete: true, dryRun: !apply, applyRequested: apply,
    summary, targets, executionVerified: false };
}
