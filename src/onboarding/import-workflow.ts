import type { HubClient } from "../client.js";
import { compareRegistry } from "../registry/diff.js";
import { importOptionsSchema } from "../registry/schema.js";
import { normalizeHub } from "./config.js";
import { followUpImport, type ImportFollowUpOptions } from "./import-follow-up.js";
import { preparedSnapshot } from "./import-config.js";
import { canonicalJson, definitionHashes, importProfileNameSchema, importProfileSchema, mutateImportProfiles,
  readImportProfile, readImportProfiles, type ImportBinding, type ImportProfile, type ImportProfileStore } from "./import-profiles.js";
import { selectImportEntries } from "./import-select.js";
import { applyImportSync, planImportSync } from "./import-sync.js";
import { prepareLocalImport, type LocalImportOptions } from "./local-import.js";

export interface ImportWorkflowOptions extends LocalImportOptions, ImportFollowUpOptions {
  profile?: string | undefined;
  saveProfile?: string | undefined;
  profilesFile?: string | undefined;
  interactive?: boolean | undefined;
  apply?: boolean | undefined;
  compare?: boolean | undefined;
  details?: boolean | undefined;
  onConflict?: string | undefined;
  tokenEnv?: string | undefined;
  readTokenEnv?: string | undefined;
}

/** Reject execution choices that cannot be satisfied by a preview or an unambiguous source profile. */
function validateWorkflow(input: ImportWorkflowOptions): void {
  if (input.interactive && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new Error("Interactive import requires a terminal. Use --select KEY for automation.");
  }
  if (input.apply && input.compare || input.details && !input.compare
    || input.interactive && (input.select !== undefined || input.profile !== undefined)
    || input.profile && input.saveProfile
    || (input.refresh || input.diagnose || input.inspectStdio) && !input.apply
    || input.inspectStdio && !input.refresh && !input.diagnose || input.stdioCwd && !input.inspectStdio) {
    throw new Error("Choose a preview or --apply. Follow-up requires --apply; stdio inspection needs --refresh/--diagnose. Interactive selection cannot override --select or --profile.");
  }
  if (input.profile && [input.clients, input.scope, input.project, input.home, input.select, input.prefix].some((value) => value !== undefined)) {
    throw new Error("A saved import profile fixes source locations and selectors. Omit --client/--scope/--project/--home/--select/--prefix.");
  }
  for (const name of [input.profile, input.saveProfile].filter((value) => value !== undefined)) {
    importProfileNameSchema.parse(name);
  }
  if ((input.profile || input.saveProfile) && input.onConflict && input.onConflict !== "error") {
    throw new Error("Managed profile imports require --on-conflict error. Use sync-local for previously managed registrations.");
  }
}

/** Validate the worst-case private ledger before starting distributed registry mutations. */
function reserveProfile(store: ImportProfileStore, name: string, profile: ImportProfile): void {
  importProfileSchema.parse(profile);
  const candidate = { ...store, profiles: { ...store.profiles, [name]: profile } };
  if (Object.keys(candidate.profiles).length > 50 || Buffer.byteLength(JSON.stringify(candidate, null, 2) + "\n", "utf8") > 1_048_576) {
    throw new Error("The proposed import-profile ledger exceeds its 50-profile/1 MiB bound. Narrow the managed group before applying.");
  }
}

/** Keep provider metadata changes in the ledger without adopting unrelated administrator edits as source-owned state. */
function recordFollowUp(bindings: ImportBinding[], expected: Awaited<ReturnType<typeof followUpImport>>["expected"]): ImportBinding[] {
  return bindings.map((binding) => {
    const target = expected.get(binding.id);
    if (!target) {
      return binding;
    }
    const hashes = definitionHashes(target);
    return { ...binding, destinationHashes: { ...binding.destinationHashes, connection: hashes.connection, capabilities: hashes.capabilities } };
  });
}

/** Select, preview, compare, import, and optionally record/inspect local connections as one explicit CLI workflow. */
export async function importLocalWorkflow(client: HubClient, hub: string, input: ImportWorkflowOptions, environment = process.env) {
  // 1. Resolve saved source settings and complete terminal selection before any optional provider inspection.
  validateWorkflow(input);
  const policy = importOptionsSchema.parse({ onConflict: input.onConflict });
  const saved = input.profile ? await readImportProfile(input.profile, input.profilesFile) : undefined;
  if (saved && normalizeHub(hub) !== saved.hub) {
    throw new Error("The saved import profile belongs to a different hub. Select its recorded hub.");
  }
  if (saved?.bindings.length && input.apply) {
    throw new Error("This profile already manages registrations. Use registry sync-local --profile NAME to preview/apply changes.");
  }
  if (input.saveProfile && Object.hasOwn((await readImportProfiles(input.profilesFile)).store.profiles, input.saveProfile)) {
    throw new Error("Import profile already exists. Use its saved settings or explicitly remove it before saving a new profile.");
  }
  let options: LocalImportOptions = saved ? { project: saved.project, scope: saved.scope, select: saved.select, prefix: saved.prefix,
    sourceLocations: saved.sources, hub, fetchA2aCards: input.fetchA2aCards } : { ...input, hub };
  if (input.interactive) {
    const discovery = await prepareLocalImport({ ...options, select: undefined, fetchA2aCards: false }, environment);
    options = { ...options, select: await selectImportEntries(discovery.entries) };
  }
  const preparation = await prepareLocalImport(options, environment);
  if (preparation.targets.length > 1000 && (input.saveProfile || saved || input.refresh || input.diagnose)) {
    throw new Error("Managed import and follow-up support at most 1000 prepared targets. Narrow the selection.");
  }
  const comparison = input.compare && preparation.ready
    ? await compareRegistry(client, preparedSnapshot(preparation.targets), { onConflict: policy.onConflict, details: input.details }) : undefined;
  const name = input.saveProfile ?? input.profile;
  const draft = saved ?? importProfileSchema.parse({ hub: normalizeHub(hub), project: preparation.project, scope: preparation.scope,
    ...(input.tokenEnv ? { tokenEnv: input.tokenEnv } : {}), ...(input.readTokenEnv ? { readTokenEnv: input.readTokenEnv } : {}),
    ...(options.select ? { select: options.select } : {}), ...(options.prefix ? { prefix: options.prefix } : {}),
    sources: preparation.sourceLocations, bindings: [] });
  const initialBindings = name ? preparation.targets.map((target) => ({ id: target.id,
    origins: preparation.entries.filter((entry) => entry.selected && entry.targetId === target.id).map((entry) => entry.key),
    sourceHashes: definitionHashes(target), destinationHashes: definitionHashes(target) })) : [];

  // 2. Import atomically; subsequent explicit metadata phases have independent guarded outcomes.
  /** Perform the network phases only after profile capacity and storage serialization have been validated. */
  async function execute(store?: ImportProfileStore, checkpoint?: () => Promise<void>) {
    if (store && name) {
      if (input.saveProfile && Object.hasOwn(store.profiles, name)
        || saved && canonicalJson(store.profiles[name]) !== canonicalJson(saved)) {
        throw new Error("Import-profile state changed during preparation; no registry changes were started.");
      }
      reserveProfile(store, name, { ...draft, bindings: input.apply ? initialBindings : draft.bindings });
    }
    const result = input.apply && preparation.ready ? await client.importRegistry(preparedSnapshot(preparation.targets), policy) : undefined;
    if (result && store && name && checkpoint) {
      store.profiles[name] = { ...draft, bindings: initialBindings };
      await checkpoint();
    }
    const followUp = result && (input.refresh || input.diagnose)
      ? await followUpImport(client, preparation.targets.map((target) => target.id), { ...input, stdioCwd: input.stdioCwd ?? preparation.project }, environment) : undefined;
    const ready = preparation.ready && (comparison?.importReady ?? true);
    const profileSaved = Boolean(store && name && ready && (input.saveProfile || result));
    if (profileSaved) {
      store!.profiles[name!] = { ...draft, bindings: result ? recordFollowUp(initialBindings, followUp?.expected ?? new Map()) : draft.bindings };
    }
    return { result: { ...preparation, ready, applied: result !== undefined, onConflict: policy.onConflict,
      hubConflictsChecked: result !== undefined || comparison !== undefined, ...(result ? { result } : {}), ...(comparison ? { comparison } : {}),
      ...(followUp ? { followUp: { outcomes: followUp.outcomes, failed: followUp.failed, executionVerified: false } } : {}),
      ...(name ? { profile: name, profileSaved } : {}), failed: !ready || Boolean(followUp?.failed) }, save: profileSaved };
  }
  return name && (input.saveProfile || input.apply) ? mutateImportProfiles(input.profilesFile, execute) : (await execute()).result;
}

/** Preview or apply source changes for one private managed profile without silently adopting existing registrations. */
export async function syncLocalWorkflow(client: HubClient, hub: string, input: {
  profile: string; profilesFile?: string | undefined; apply?: boolean | undefined; prune?: boolean | undefined;
  fetchA2aCards?: boolean | undefined;
} & ImportFollowUpOptions, environment = process.env) {
  // 1. Resolve pinned sources and observe current metadata; missing selected keys are tracked removals rather than typos.
  if ((input.refresh || input.diagnose || input.inspectStdio) && !input.apply
    || input.inspectStdio && !input.refresh && !input.diagnose || input.stdioCwd && !input.inspectStdio) {
    throw new Error("Follow-up requires --apply; --inspect-stdio needs --refresh or --diagnose.");
  }
  const profile = await readImportProfile(input.profile, input.profilesFile);
  if (normalizeHub(hub) !== profile.hub) {
    throw new Error("The saved import profile belongs to a different hub.");
  }
  const preparation = await prepareLocalImport({ project: profile.project, scope: profile.scope, select: profile.select, prefix: profile.prefix,
    sourceLocations: profile.sources, hub, fetchA2aCards: input.fetchA2aCards, allowMissingSelected: true }, environment);
  if (preparation.targets.length > 1000) {
    throw new Error("Managed synchronization supports at most 1000 incoming targets.");
  }
  const plan = await planImportSync(client, profile, preparation, input.prune);
  const { operations: _operations, ...publicPlan } = plan;
  const preview = { profile: input.profile, ready: plan.ready, applied: false, prune: Boolean(input.prune),
    plan: publicPlan, sourceIssues: preparation.issues, requiredEnvironmentVariables: preparation.requiredEnvironmentVariables, executionVerified: false as const };
  if (!input.apply || !plan.ready) {
    return { ...preview, failed: !plan.ready };
  }

  // 2. Serialize local ledger writers and reserve enough space even if some independent network writes fail.
  return mutateImportProfiles(input.profilesFile, async (store, checkpoint) => {
    if (canonicalJson(store.profiles[input.profile]) !== canonicalJson(profile)) {
      throw new Error("Import-profile state changed during preparation; synchronize again before applying.");
    }
    const worst = new Map(profile.bindings.map((binding) => [binding.id, binding]));
    for (const operation of plan.operations.filter((item) => item.action === "added")) {
      worst.set(operation.id, { id: operation.id, origins: operation.origins,
        sourceHashes: operation.sourceHashes!, destinationHashes: definitionHashes(operation.incoming!) });
    }
    reserveProfile(store, input.profile, { ...profile, bindings: [...worst.values()] });
    const result = await applyImportSync(client, profile, plan, async (bindings) => {
      store.profiles[input.profile] = { ...profile, bindings };
      await checkpoint();
    });
    store.profiles[input.profile] = { ...profile, bindings: result.bindings };
    await checkpoint();
    const ids = plan.items.filter((item) => ["added", "updated", "unchanged"].includes(item.action)
      && result.outcomes.some((outcome) => outcome.id === item.id && outcome.status !== "failed")).map((item) => item.id);
    const followUp = input.refresh || input.diagnose
      ? await followUpImport(client, ids, { ...input, stdioCwd: input.stdioCwd ?? profile.project }, environment) : undefined;
    store.profiles[input.profile] = { ...profile, bindings: recordFollowUp(result.bindings, followUp?.expected ?? new Map()) };
    return { result: { ...preview, applied: result.applied, outcomes: result.outcomes,
      ...(followUp ? { followUp: { outcomes: followUp.outcomes, failed: followUp.failed, executionVerified: false } } : {}),
      failed: result.failed || Boolean(followUp?.failed) }, save: true };
  });
}

/** Render source-qualified choices and phase summaries without copying credential values or private ledger fingerprints. */
export function formatImportWorkflow(report: Awaited<ReturnType<typeof importLocalWorkflow>>): string {
  return report.converted + "/" + report.selected + " selected connections prepared. " + (report.applied ? "Imported to the hub." : "Preview only.")
    + "\n" + report.entries.map((entry) => JSON.stringify(entry.key) + " " + entry.status + (entry.targetId ? " -> " + entry.targetId : "")).join("\n")
    + "\n" + report.issues.map((issue) => issue.severity.toUpperCase() + " " + JSON.stringify(issue.name) + " " + issue.code + ": " + issue.message).join("\n")
    + (report.requiredEnvironmentVariables.length ? "\nRequired environment names: " + report.requiredEnvironmentVariables.join(", ") : "")
    + (report.profile ? "\nProfile: " + JSON.stringify(report.profile) + (report.profileSaved ? " (saved)" : "") : "")
    + (report.followUp ? "\nFollow-up: " + report.followUp.outcomes.map((item) => item.id + " " + item.status + (item.updated ? " (metadata updated)" : "")).join(", ") : "")
    + "\nNo target tools or A2A tasks were invoked.";
}
