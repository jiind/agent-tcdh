import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { envNameSchema, normalizeHub } from "./config.js";
import { readConfigText, writeConfigText } from "./files.js";

export const hubProfileName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const hubProfileSchema = z.object({ hub: z.string().transform(normalizeHub), tokenEnv: envNameSchema.optional(),
  readTokenEnv: envNameSchema.optional() }).strict().refine((v) => !v.readTokenEnv || v.readTokenEnv !== v.tokenEnv,
  "Read and administrator references must differ.");
export type HubProfile = z.infer<typeof hubProfileSchema>;
const storeSchema = z.object({ schemaVersion: z.literal(1), active: hubProfileName.optional(),
  profiles: z.record(hubProfileName, hubProfileSchema) }).strict().superRefine((v, ctx) => {
  if (Object.keys(v.profiles).length > 50 || v.active && !Object.hasOwn(v.profiles, v.active)) {
    ctx.addIssue({ code: "custom", message: "Invalid profile count or active selection." });
  }
});

/** Read a bounded private collection without resolving credential values. */
export async function readHubProfiles(file?: string) {
  const path = resolve(file ?? join(homedir(), ".agent-tcdh", "hub-profiles.json"));
  const text = await readConfigText(path);
  try {
    return { path, text, store: storeSchema.parse(text === undefined ? { schemaVersion: 1, profiles: {} } : JSON.parse(text.replace(/^\uFEFF/u, ""))) };
  } catch {
    throw new Error("Invalid hub-profile storage. Contents were not printed; select --hub-profiles-file or repair the file.");
  }
}

/** Resolve an explicit or active consumer hub independently of server configuration. */
export async function resolveHubProfile(name?: string, file?: string) {
  const loaded = await readHubProfiles(file);
  const selected = name === undefined ? loaded.store.active : hubProfileName.parse(name);
  if (!selected) {
    return undefined;
  }
  if (!Object.hasOwn(loaded.store.profiles, selected)) {
    throw new Error("Hub profile not found.");
  }
  return { name: selected, ...loaded.store.profiles[selected]! };
}

/** Preview or serialize a profile mutation with exact backups and optimistic file checks. */
export async function manageHubProfile(action: string, name: string | undefined, file: string | undefined,
  definition: unknown, apply = false) {
  // 1. Validate action and acquire a cooperating operation lock only for explicit changes.
  if (!["list", "show", "save", "use", "remove", "clear"].includes(action)) {
    throw new Error("Use hub-profile list, show/save/use/remove NAME, or clear.");
  }
  if (!["list", "clear"].includes(action)) {
    hubProfileName.parse(name);
  }
  const initial = await readHubProfiles(file);
  let lock;
  if (apply && !["list", "show"].includes(action)) {
    await mkdir(dirname(initial.path), { recursive: true });
    try {
      lock = await open(initial.path + ".operation.lock", "wx", 0o600);
    } catch {
      throw new Error("Another hub-profile operation is in progress or storage is unavailable.");
    }
  }
  try {
    // 2. Reread under the lock and change only the selected entry or active name.
    const loaded = lock ? await readHubProfiles(initial.path) : initial;
    const store = loaded.store;
    const existing = name && Object.hasOwn(store.profiles, name) ? store.profiles[name] : undefined;
    if (["show", "use", "remove"].includes(action) && !existing) {
      throw new Error("Hub profile not found.");
    }
    if (action === "list") {
      return { path: loaded.path, active: store.active ?? null, profiles: Object.entries(store.profiles).map(([name, value]) => ({ name, ...value })) };
    }
    if (action === "show") {
      return { name, profile: existing };
    }
    if (action === "save") {
      if (existing) {
        throw new Error("Hub profile already exists. Remove it explicitly before reusing the name.");
      }
      store.profiles[name!] = hubProfileSchema.parse(definition);
    } else if (action === "use") {
      store.active = name!;
    } else if (action === "remove") {
      delete store.profiles[name!];
      if (store.active === name) {
        delete store.active;
      }
    } else {
      delete store.active;
    }
    const validated = storeSchema.parse(store);
    const written = apply ? await writeConfigText(loaded.path, JSON.stringify(validated, null, 2) + "\n", loaded.text) : undefined;
    return { action, name, applied: apply, active: store.active ?? null, ...(written ? { path: written.path, backup: written.backup } : {}) };
  } finally {
    if (lock) {
      await lock.close();
      await rm(initial.path + ".operation.lock", { force: true });
    }
  }
}
