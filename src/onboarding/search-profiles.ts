import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { discoverySearchSchema } from "../targets/schema.js";
import { readConfigText, writeConfigText } from "./files.js";
import { hubProfileName } from "./hub-profiles.js";

const profileOptions = discoverySearchSchema.omit({ cursor: true, offset: true });
const profileDocument = z.strictObject({ version: z.literal(1), profiles: z.record(hubProfileName, profileOptions) });

export async function searchProfiles(file?: string) {
  const path = resolve(file ?? resolve(homedir(), ".agent-tcdh", "search-profiles.json"));
  const text = await readConfigText(path);
  let store: z.infer<typeof profileDocument>;
  try {
    store = text === undefined ? { version: 1, profiles: {} } : profileDocument.parse(JSON.parse(text));
  } catch {
    throw new Error("Search profile storage contains invalid data.");
  }
  return { path, text, store };
}

export async function loadSearchProfile(name: string, file?: string) {
  const { store } = await searchProfiles(file);
  name = hubProfileName.parse(name);
  if (!Object.hasOwn(store.profiles, name)) {
    throw new Error("Search profile not found.");
  }
  return store.profiles[name]!;
}

export async function manageSearchProfiles(action: string, name: string | undefined, file: string | undefined,
  options: Record<string, unknown>, apply?: boolean, replace?: boolean) {
  const { path, text, store } = await searchProfiles(file);
  if (action === "list") {
    return { path, profiles: Object.keys(store.profiles).sort() };
  }
  const key = hubProfileName.parse(name);
  const current = Object.hasOwn(store.profiles, key) ? store.profiles[key] : undefined;
  if (action === "show" || action === "remove") {
    if (!current) {
      throw new Error("Search profile not found.");
    }
    if (action === "show") {
      return { path, name: key, options: current };
    }
    delete store.profiles[key];
  } else {
    if (current && !replace) {
      throw new Error("Search profile exists. Use --replace to update it.");
    }
    if (!current && Object.keys(store.profiles).length >= 50) {
      throw new Error("Search profile storage supports at most 50 profiles.");
    }
    store.profiles[key] = profileOptions.parse(options);
  }
  const write = apply ? await writeConfigText(path, JSON.stringify(store, null, 2) + "\n", text) : undefined;
  return { path, name: key, action, applied: Boolean(apply), changed: write?.changed ?? false,
    ...(action === "save" ? { options: store.profiles[key] } : {}) };
}
