import { isDeepStrictEqual } from "node:util";
import type { HubClient } from "../client.js";
import { inspectRemote, remoteImportSchema } from "../remote-import.js";
import { inspectStdio, StdioInspectionCancelled } from "../stdio-inspect.js";
import { targetDefinitionSchema, type TargetDefinition } from "../targets/schema.js";

export interface ImportFollowUpOptions {
  refresh?: boolean | undefined;
  diagnose?: boolean | undefined;
  inspectStdio?: boolean | undefined;
  stdioCwd?: string | undefined;
}

/** Inspect one registered target's declared metadata using only its provider credential references. */
async function metadata(target: TargetDefinition, options: ImportFollowUpOptions, environment: NodeJS.ProcessEnv) {
  if (target.connection.transport === "stdio") {
    if (!options.inspectStdio) {
      return undefined;
    }
    return inspectStdio(target, { allow: true, cwd: options.stdioCwd }, environment);
  }
  const auth = target.connection.auth;
  if (auth && auth.type !== "none" && (auth.type !== "bearer" || auth.envVars.length !== 1)) {
    return undefined;
  }
  return inspectRemote(remoteImportSchema.parse({ id: target.id, protocol: target.protocol,
    url: target.protocol === "a2a" ? target.connection.agentCardUrl ?? new URL("/.well-known/agent-card.json", target.connection.url).href : target.connection.url,
    transport: target.protocol === "mcp" ? target.connection.transport : undefined,
    bearerEnv: auth?.type === "bearer" ? auth.envVars[0] : undefined,
    a2aBinding: target.protocol === "a2a" ? target.connection.protocolBinding : undefined,
    a2aVersion: target.protocol === "a2a" ? target.connection.protocolVersion : undefined }), environment);
}

/** Refresh and/or diagnose a bounded imported group, reusing one metadata observation per target and never invoking tools/tasks. */
export async function followUpImport(client: Pick<HubClient, "getVersioned" | "update">, ids: string[], options: ImportFollowUpOptions,
  environment: NodeJS.ProcessEnv = process.env) {
  if (ids.length > 1000 || new Set(ids).size !== ids.length || options.inspectStdio && !options.refresh && !options.diagnose) {
    throw new Error("Follow-up requires at most 1000 unique IDs; --inspect-stdio requires --refresh or --diagnose.");
  }
  const outcomes: { id: string; status: "passed" | "skipped" | "failed"; metadataInspected: boolean; updated: boolean;
    diagnosis?: "matched" | "drift" | "not-requested"; capabilities?: { registered: number; observed: number; names: string[] }; issue?: string }[] = [];
  const expected = new Map<string, TargetDefinition>();
  let cancelled = false;
  for (const id of ids) {
    let inspected = false;
    try {
      const before = await client.getVersioned(id);
      const target = targetDefinitionSchema.parse({ id: before.target.id, name: before.target.name, description: before.target.description,
        protocol: before.target.protocol, tags: before.target.tags, enabled: before.target.enabled,
        connection: before.target.connection, capabilities: before.target.capabilities });
      if (!target.enabled) {
        outcomes.push({ id, status: "skipped", metadataInspected: false, updated: false, issue: "TARGET_DISABLED" });
        continue;
      }
      const observed = await metadata(target, options, environment);
      if (!observed) {
        outcomes.push({ id, status: "skipped", metadataInspected: false, updated: false, issue: "INSPECTION_NOT_AUTHORIZED_OR_SUPPORTED" });
        continue;
      }
      inspected = true;
      const current = await client.getVersioned(id);
      if (!current.target.enabled || !isDeepStrictEqual(current.target.connection, target.connection) || current.target.protocol !== target.protocol) {
        throw new Error("Registration changed during inspection.");
      }
      const proposed = targetDefinitionSchema.parse({ id, name: current.target.name, description: current.target.description,
        protocol: current.target.protocol, tags: current.target.tags, enabled: current.target.enabled,
        capabilities: observed.capabilities,
        connection: current.target.protocol === "a2a" && observed.protocol === "a2a" ? { ...current.target.connection,
          url: observed.connection.url,
          ...(observed.connection.agentCardUrl ? { agentCardUrl: observed.connection.agentCardUrl } : {}),
          ...(observed.connection.protocolBinding ? { protocolBinding: observed.connection.protocolBinding } : {}),
          ...(observed.connection.protocolVersion ? { protocolVersion: observed.connection.protocolVersion } : {}) }
          : current.target.connection });
      const drift = !isDeepStrictEqual(current.target.capabilities, proposed.capabilities) || !isDeepStrictEqual(current.target.connection, proposed.connection);
      const updated = Boolean(options.refresh && drift);
      if (updated) {
        await client.update(id, proposed, current.etag);
      }
      if (options.refresh) {
        expected.set(id, proposed);
      }
      outcomes.push({ id, status: !options.refresh && options.diagnose && drift ? "failed" : "passed", metadataInspected: true, updated,
        capabilities: { registered: current.target.capabilities.length, observed: observed.capabilities.length, names: observed.capabilities.map((capability) => capability.name) },
        diagnosis: options.diagnose ? options.refresh || !drift ? "matched" : "drift" : "not-requested" });
    } catch (error) {
      cancelled = error instanceof StdioInspectionCancelled;
      outcomes.push({ id, status: "failed", metadataInspected: inspected, updated: false, issue: cancelled ? "INSPECTION_CANCELLED" : "IMPORT_INSPECTION_FAILED" });
      if (cancelled) {
        break;
      }
    }
  }
  for (const id of ids.filter((id) => !outcomes.some((item) => item.id === id))) {
    outcomes.push({ id, status: "skipped", metadataInspected: false, updated: false, issue: "INSPECTION_CANCELLED" });
  }
  return { outcomes, failed: outcomes.some((item) => item.status === "failed"), cancelled, executionVerified: false as const, expected };
}
