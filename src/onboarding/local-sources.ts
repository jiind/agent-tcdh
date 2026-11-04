import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const localClientSchema = z.enum(["codex", "claude-code", "opencode", "gemini-cli", "cursor", "vscode"]);
export const localScopeSchema = z.enum(["all", "user", "project"]);
export type LocalClient = z.infer<typeof localClientSchema>;
export interface LocalSource {
  id: string;
  client: LocalClient;
  scope: "user" | "project" | "local";
  path: string;
  kind: "mcp" | "a2a";
}
export interface LocalSourceOptions {
  clients?: string[] | undefined;
  scope?: string | undefined;
  home?: string | undefined;
  project?: string | undefined;
}

/** Enumerate fixed client locations in the chosen home/project without walking ancestor or unrelated directories. */
export function localSourceLocations(input: LocalSourceOptions, environment = process.env, platform = process.platform) {
  // 1. Validate scope and clients before consulting the filesystem.
  const scope = localScopeSchema.parse(input.scope ?? "all");
  const clients = input.clients ?? localClientSchema.options;
  if (!clients.length || new Set(clients).size !== clients.length) {
    throw new Error("Choose unique local client names.");
  }
  clients.forEach((client) => localClientSchema.parse(client));
  const home = resolve(input.home ?? homedir());
  const project = resolve(input.project ?? process.cwd());
  const env = input.home === undefined ? environment : {};
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const sources: LocalSource[] = [];
  /** Add a deterministic source only when its client and scope were requested. */
  function add(client: LocalClient, sourceScope: LocalSource["scope"], path: string, suffix = "", kind: LocalSource["kind"] = "mcp") {
    if (clients.includes(client) && (scope === "all" || scope === sourceScope || scope === "project" && sourceScope === "local")) {
      sources.push({ id: client + "-" + sourceScope + suffix, client, scope: sourceScope, path: resolve(path), kind });
    }
  }

  // 2. Include raw declarations as independent sources rather than emulating client precedence or trust.
  add("codex", "user", join(env.CODEX_HOME || join(home, ".codex"), "config.toml"));
  add("codex", "project", join(project, ".codex", "config.toml"));
  add("claude-code", "user", join(home, ".claude.json"));
  add("claude-code", "project", join(project, ".mcp.json"));
  add("claude-code", "local", join(home, ".claude.json"));
  for (const extension of ["json", "jsonc"]) {
    add("opencode", "user", join(config, "opencode", "opencode." + extension), "-" + extension);
    add("opencode", "project", join(project, "opencode." + extension), "-" + extension);
    add("opencode", "project", join(project, ".opencode", "opencode." + extension), "-directory-" + extension);
  }
  if (env.OPENCODE_CONFIG) {
    add("opencode", "user", env.OPENCODE_CONFIG, "-custom");
  }
  add("gemini-cli", "user", join(home, ".gemini", "settings.json"));
  add("gemini-cli", "project", join(project, ".gemini", "settings.json"));
  add("gemini-cli", "user", join(home, ".gemini", "agents"), "-agents", "a2a");
  add("gemini-cli", "project", join(project, ".gemini", "agents"), "-agents", "a2a");
  add("cursor", "user", join(home, ".cursor", "mcp.json"));
  add("cursor", "project", join(project, ".cursor", "mcp.json"));
  const editor = platform === "darwin" ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming") : config;
  add("vscode", "user", join(editor, "Code", "User", "mcp.json"));
  add("vscode", "project", join(project, ".vscode", "mcp.json"));
  return { sources, home, project, scope, clients };
}

/** Expand only bounded Gemini agent directories, leaving linked or invalid directories as explicit source errors. */
export async function expandLocalSources(sources: LocalSource[]): Promise<LocalSource[]> {
  const expanded: LocalSource[] = [];
  for (const source of sources) {
    if (source.kind === "mcp") {
      expanded.push(source);
      continue;
    }
    try {
      const info = await lstat(source.path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        expanded.push(source);
        continue;
      }
      const directory = await opendir(source.path);
      let scanned = 0;
      const entries: LocalSource[] = [];
      for await (const entry of directory) {
        if (++scanned > 1000) {
          throw new Error("Agent directory scan limit exceeded.");
        }
        if (entry.name.endsWith(".md")) {
          entries.push({ ...source, id: source.id + "-" + encodeURIComponent(entry.name), path: join(source.path, entry.name) });
        }
        if (entries.length > 100) {
          throw new Error("Agent definition limit exceeded.");
        }
      }
      expanded.push(...entries.sort((left, right) => left.id.localeCompare(right.id, "en")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") {
        expanded.push(source);
      } else if (!code) {
        throw new Error("Unable to enumerate the bounded local agent directory. Use --client or --scope to narrow the scan.");
      }
    }
    if (expanded.length > 128) {
      throw new Error("Local import supports at most 128 source files. Narrow the scan.");
    }
  }
  return expanded;
}
