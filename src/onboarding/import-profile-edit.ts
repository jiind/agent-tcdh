import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, importProfileSchema, mutateImportProfiles, readImportProfile } from "./import-profiles.js";
import { prepareLocalImport } from "./local-import.js";

/** Preview source/selection edits while retaining all managed ownership for later explicit synchronization. */
export async function editImportProfile(name: string, file: string | undefined, options: {
  select?: string[] | undefined; allSources?: boolean | undefined; project?: string | undefined;
  sourcePaths?: string[] | undefined; apply?: boolean | undefined;
}) {
  // 1. Build a candidate without clearing bindings or silently changing its hub and ID namespace.
  if (options.select && options.allSources || !options.select && !options.allSources && !options.project && !options.sourcePaths?.length) {
    throw new Error("Choose --select KEY, --all-sources, --project DIR, or --source-path SOURCE_ID=PATH.");
  }
  const previous = await readImportProfile(name, file);
  const candidate = structuredClone(previous);
  if (options.allSources) {
    delete candidate.select;
  } else if (options.select) {
    candidate.select = options.select;
  }
  if (options.project) {
    candidate.project = resolve(options.project);
    candidate.sources = candidate.sources.map((source) => {
      if (source.scope !== "project") {
        return source;
      }
      const suffix = relative(previous.project, source.path);
      if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../") || suffix.startsWith("..\\")) {
        throw new Error("A project source is outside the previous root; relocate it with --source-path.");
      }
      return { ...source, path: resolve(candidate.project, suffix) };
    });
  }
  const changed = new Set<string>();
  for (const value of options.sourcePaths ?? []) {
    const index = value.indexOf("=");
    const id = value.slice(0, index);
    const source = candidate.sources.find((source) => source.id === id);
    if (index < 1 || !value.slice(index + 1) || !source || changed.has(id)) {
      throw new Error("Use each known source ID once with --source-path SOURCE_ID=PATH.");
    }
    changed.add(id);
    source.path = resolve(value.slice(index + 1));
  }
  const profile = importProfileSchema.parse(candidate);
  const preparation = await prepareLocalImport({ sourceLocations: profile.sources, project: profile.project, scope: profile.scope,
    select: profile.select, prefix: profile.prefix, hub: profile.hub, allowMissingSelected: true });
  // 2. Publish local configuration only after validation; source removals remain a separately previewed sync decision.
  if (options.apply && !preparation.ready) {
    throw new Error("Edited sources are not ready. Review the preview before applying; no profile or registry changes were made.");
  }
  if (options.apply) {
    await mutateImportProfiles(file, async (store) => {
      if (canonicalJson(store.profiles[name]) !== canonicalJson(previous)) {
        throw new Error("Import profile changed during preparation; preview again.");
      }
      store.profiles[name] = profile;
      return { result: undefined, save: true };
    });
  }
  return { name, applied: Boolean(options.apply), ready: preparation.ready, profile,
    entries: preparation.entries, issues: preparation.issues, missingSelections: preparation.missingSelections,
    registryChanged: false, nextCommand: ["agent-tcdh", "registry", "sync-local", "--profile", name] };
}
