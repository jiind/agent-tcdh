import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { targetIdSchema, type TargetDefinition } from "../targets/schema.js";
import { envNameSchema, normalizeHub } from "./config.js";
import { readConfigText, writeConfigText } from "./files.js";
import { importPrefixSchema } from "./import-config.js";
import { localClientSchema, localScopeSchema } from "./local-sources.js";

export const importFields = ["name", "description", "protocol", "tags", "capabilities", "connection", "enabled"] as const;
export type ImportField = (typeof importFields)[number];
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const hashesSchema = z.object({ name: hash, description: hash, protocol: hash, tags: hash, capabilities: hash, connection: hash, enabled: hash }).strict();
const absolutePath = z.string().min(1).max(4096).refine(isAbsolute, "Profile paths must be absolute.");
export const importProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const importBindingSchema = z.object({
  id: targetIdSchema,
  origins: z.array(z.string().min(1).max(4096)).min(1).max(1000),
  sourceHashes: hashesSchema,
  destinationHashes: hashesSchema,
}).strict();
export type ImportBinding = z.infer<typeof importBindingSchema>;
export const importProfileSchema = z.object({
  hub: z.string().transform(normalizeHub),
  tokenEnv: envNameSchema.optional(),
  readTokenEnv: envNameSchema.optional(),
  project: absolutePath,
  scope: localScopeSchema,
  select: z.array(z.string().min(1).max(4096)).min(1).max(1000).optional(),
  prefix: importPrefixSchema.optional(),
  sources: z.array(z.object({ id: z.string().min(1).max(1024), client: localClientSchema,
    scope: z.enum(["user", "project", "local"]), path: absolutePath, kind: z.enum(["mcp", "a2a"]) }).strict()).max(64),
  bindings: z.array(importBindingSchema).max(1000),
}).strict().superRefine((profile, context) => {
  for (const values of [profile.sources.map((item) => item.id), profile.bindings.map((item) => item.id), profile.select ?? []]) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Profile sources, target IDs, and selections must be unique." });
    }
  }
});
export type ImportProfile = z.infer<typeof importProfileSchema>;
const profileStoreSchema = z.object({ schemaVersion: z.literal(1), profiles: z.record(importProfileNameSchema, importProfileSchema) }).strict()
  .refine((store) => Object.keys(store.profiles).length <= 50, "At most 50 import profiles may be saved.");
export type ImportProfileStore = z.infer<typeof profileStoreSchema>;

/** Canonicalize JSON object keys without changing array ordering or resolving any configuration values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : child);
}

/** Store per-field fingerprints rather than source definitions, command arguments, or credential values. */
export function definitionHashes(target: TargetDefinition): Record<ImportField, string> {
  return Object.fromEntries(importFields.map((field) => [field, createHash("sha256").update(canonicalJson(target[field])).digest("hex")])) as Record<ImportField, string>;
}

/** Resolve private import-profile storage independently from client source homes or hub configuration. */
export function importProfilesPath(file?: string): string {
  return resolve(file ?? join(homedir(), ".agent-tcdh", "import-profiles.json"));
}

/** Read a bounded profile store while replacing parser diagnostics with fixed messages. */
export async function readImportProfiles(file?: string) {
  const path = importProfilesPath(file);
  const text = await readConfigText(path);
  try {
    const store = profileStoreSchema.parse(text === undefined ? { schemaVersion: 1, profiles: {} } : JSON.parse(text.replace(/^\uFEFF/u, "")));
    return { path, text, store };
  } catch {
    throw new Error("Invalid import-profile storage. Contents were not printed; repair it or choose --profiles-file.");
  }
}

/** Require an existing named profile without contacting a hub or inspecting client sources. */
export async function readImportProfile(name: string, file?: string): Promise<ImportProfile> {
  importProfileNameSchema.parse(name);
  const { store } = await readImportProfiles(file);
  const profile = Object.hasOwn(store.profiles, name) ? store.profiles[name] : undefined;
  if (!profile) {
    throw new Error("Import profile not found. Save one with registry import-local --save-profile NAME first.");
  }
  return profile;
}

/** Serialize cooperating profile mutations across registry writes and atomically publish the final private ledger. */
export async function mutateImportProfiles<T>(file: string | undefined,
  action: (store: ImportProfileStore, checkpoint: () => Promise<void>) => Promise<{ result: T; save: boolean }>): Promise<T> {
  // 1. Own a separate operation lock before reading state or allowing a registry mutation.
  const path = importProfilesPath(file);
  await mkdir(dirname(path), { recursive: true });
  const lockPath = path + ".operation.lock";
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("Another import-profile operation is in progress or storage is unavailable. Retry after it finishes.");
  }
  try {
    const loaded = await readImportProfiles(path);
    let expected = loaded.text;
    /** Durably checkpoint acknowledged ownership before starting optional metadata requests or later mutations. */
    async function checkpoint() {
      const store = profileStoreSchema.parse(loaded.store);
      const content = JSON.stringify(store, null, 2) + "\n";
      try {
        await writeConfigText(path, content, expected);
        expected = content;
      } catch {
        throw new Error("Import-profile state could not be saved. Registry changes may already have completed; inspect the hub and profile before retrying.");
      }
    }
    const { result, save } = await action(loaded.store, checkpoint);
    if (save) {
      await checkpoint();
    }
    return result;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
