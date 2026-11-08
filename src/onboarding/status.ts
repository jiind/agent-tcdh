import { HubClient } from "../client.js";
import { readClientToken } from "../auth.js";
import { searchSchema } from "../targets/schema.js";
import { batchTargetOptionsSchema, selectBatchTargets } from "../targets/batch.js";
import { readImportProfiles } from "./import-profiles.js";
import { syncLocalWorkflow } from "./import-workflow.js";
import { normalizeHub } from "./config.js";

/** Show consumer prerequisites, source drift, and stored freshness without contacting any target provider. */
export async function managementStatus(options: { hub: string; tokenEnv?: string | undefined; profilesFile?: string | undefined;
  staleHours?: number | undefined; limit?: number | undefined; hubProfile?: string | undefined }, environment = process.env) {
  // 1. Keep credential failures local and suppress values and arbitrary remote error messages.
  const hub = normalizeHub(options.hub);
  const checks: { section: string; status: string; message: string }[] = [];
  const requirements = new Set<string>();
  let token;
  try {
    token = readClientToken(options.tokenEnv, options.tokenEnv !== undefined, environment);
  } catch {
    checks.push({ section: "hub", status: "failed", message: "Selected hub credential is missing or invalid." });
    return { hub, checks, executionVerified: false, failed: true };
  }
  const client = new HubClient(hub, token);
  let counts: { total: number; enabled: number; disabled: number } | undefined;
  let freshness: Awaited<ReturnType<HubClient["freshness"]>> | undefined;
  const profiles: { name: string; status: string; changes?: Record<string, number>; issue?: string }[] = [];
  try {
    const all = await client.search(searchSchema.parse({ includeDisabled: true, limit: 1 }));
    const enabled = await client.search(searchSchema.parse({ limit: 1 }));
    counts = { total: all.total, enabled: enabled.total, disabled: Math.max(0, all.total - enabled.total) };
    checks.push({ section: "hub", status: "passed", message: "Authenticated registry discovery is accessible." });
  } catch {
    checks.push({ section: "hub", status: "failed", message: "Registry discovery is unavailable. Check hub URL and credentials." });
  }
  if (counts) {
    // 2. Inspect only registered references and registry observations; MCP/A2A endpoints are never called.
    const selection = await selectBatchTargets(client, batchTargetOptionsSchema.parse({ includeDisabled: true, limit: options.limit ?? 1000 }));
    if (selection.issue) {
      checks.push({ section: "environment", status: "warning", message: selection.issue.message });
    }
    for (const target of selection.targets) {
      const names = target.connection.transport === "stdio" ? target.connection.envVars : target.connection.auth?.envVars ?? [];
      names.forEach((name) => requirements.add(name));
    }
    try {
      freshness = await client.freshness({ staleHours: options.staleHours ?? 24, limit: options.limit ?? 1000, offset: 0 });
      checks.push({ section: "freshness", status: freshness.total > freshness.items.length ? "warning" : "passed",
        message: freshness.total > freshness.items.length ? "Freshness is a bounded first page; use target freshness --offset for remaining targets." : "Stored metadata observations loaded; no provider inspections were made." });
    } catch {
      checks.push({ section: "freshness", status: "warning", message: "Stored metadata observations are unavailable. Upgrade the hub if necessary." });
    }
  }
  try {
    const loaded = await readImportProfiles(options.profilesFile);
    for (const [name, profile] of Object.entries(loaded.store.profiles)) {
      if (profile.hub !== hub || !counts) {
        profiles.push({ name, status: "skipped", issue: profile.hub !== hub ? "DIFFERENT_HUB" : "HUB_UNAVAILABLE" });
        continue;
      }
      try {
        const report = await syncLocalWorkflow(client, hub, { profile: name, profilesFile: loaded.path }, environment);
        const changes: Record<string, number> = {};
        for (const item of report.plan.items) {
          changes[item.action] = (changes[item.action] ?? 0) + 1;
        }
        profiles.push({ name, status: report.ready ? "passed" : "warning", changes });
        report.requiredEnvironmentVariables.forEach((name) => requirements.add(name));
      } catch {
        profiles.push({ name, status: "warning", issue: "SOURCE_OR_PROFILE_UNAVAILABLE" });
      }
    }
  } catch {
    checks.push({ section: "profiles", status: "warning", message: "Import-profile storage could not be inspected." });
  }
  const variables = [...requirements].sort().map((name) => ({ name, available: Boolean(environment[name]) }));
  if (variables.some((variable) => !variable.available)) {
    checks.push({ section: "environment", status: "warning", message: "Some registered environment references are missing in this consumer process." });
  }
  return { hub, hubProfile: options.hubProfile ?? null, checks, counts, freshness, profiles, variables,
    providerRequests: false, executionVerified: false, failed: checks.some((check) => check.status === "failed") };
}
