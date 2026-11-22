import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { envNameSchema, normalizeHub } from "./config.js";
import { ConfigurationFileError, readConfigText, writeConfigText } from "./files.js";

export const connectionClientSchema = z.enum(["codex", "opencode", "opencode-v1", "claude-code", "gemini-cli", "cursor", "vscode"]);
export type ConnectionClient = z.infer<typeof connectionClientSchema>;

/** Identify profiles that launch the existing local discovery bridge. */
function usesBridge(client: ConnectionClient): boolean {
  return !["codex", "opencode", "opencode-v1"].includes(client);
}

/** Generate a local Node invocation with client-specific environment references and isolated bridge settings. */
function bridgeEntry(client: ConnectionClient, hub: string, tokenEnv?: string) {
  // 1. Pin this installation and the selected hub without relying on shell shims or personal setup files.
  const command = process.execPath;
  const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  if ([command, entry, hub].some((value) => value.includes("${"))) {
    throw new Error("Bridge paths and hub URLs must not contain client interpolation expressions.");
  }
  const args = [entry, "mcp", "--hub", normalizeHub(hub), "--no-config",
    ...(tokenEnv ? ["--token-env", tokenEnv] : ["--anonymous"])];

  // 2. Pass only the selected variable explicitly, keeping its value in the consuming client environment.
  const reference = client === "cursor" || client === "vscode" ? "${env:" : "${";
  return { ...(client === "gemini-cli" ? {} : { type: "stdio" }), command, args,
    ...(tokenEnv ? { env: { [tokenEnv]: reference + tokenEnv + "}" } } : {}) };
}

/** Require an object-shaped configuration container before merging a named server. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ConfigurationFileError("The existing configuration container must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Compare configuration values without treating parser-created null prototypes as a semantic change. */
export function sameValue(left: unknown, right: unknown): boolean {
  /** Normalize tables recursively while preserving arrays, dates, and integer values. */
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  }
  return isDeepStrictEqual(normalize(left), normalize(right));
}

/** Parse TOML with a fixed diagnostic that never echoes existing secrets. */
function toml(text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch {
    throw new ConfigurationFileError("Invalid TOML configuration. Fix it before adding the hub.");
  }
}

/** Parse the selected client layout without exposing source values in diagnostics. */
export function connectionDocument(client: ConnectionClient, existing: string, name: string) {
  if (client === "codex") {
    const root = toml(existing);
    return { root, servers: root.mcp_servers === undefined ? {} : object(root.mcp_servers),
      path: ["mcp_servers", name], bom: "", text: existing };
  }
  const errors: ParseError[] = [];
  const bom = existing.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = (existing.trim() ? existing : "{}\n").replace(/^\uFEFF/u, "");
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ConfigurationFileError("Invalid JSON/JSONC configuration. Fix it before using the hub configuration.");
  }
  const root = object(parsed);
  let servers: Record<string, unknown>;
  let path: string[];
  if (client === "opencode" || client === "opencode-v1") {
    const mcp = root.mcp === undefined ? {} : object(root.mcp);
    if (client === "opencode" && Object.entries(mcp).some(([key, value]) => key !== "servers"
      && value && typeof value === "object" && "type" in value)) {
      throw new ConfigurationFileError("This file uses OpenCode v1 server layout. Select opencode-v1 or migrate it first.");
    }
    if (client === "opencode-v1" && mcp.servers !== undefined && !["remote", "local"].includes(String(object(mcp.servers).type))) {
      throw new ConfigurationFileError("This file uses OpenCode v2 server layout. Select opencode.");
    }
    servers = client === "opencode" ? (mcp.servers === undefined ? {} : object(mcp.servers)) : mcp;
    path = client === "opencode" ? ["mcp", "servers", name] : ["mcp", name];
  } else {
    const key = client === "vscode" ? "servers" : "mcpServers";
    const alternate = client === "vscode" ? "mcpServers" : "servers";
    if (root[key] === undefined && root[alternate] !== undefined) {
      throw new ConfigurationFileError("This file uses a different MCP server container. Select the matching client profile or choose another file.");
    }
    servers = root[key] === undefined ? {} : object(root[key]);
    path = [key, name];
  }
  return { root, servers, path, bom, text };
}

/** Validate an explicitly selected client server name before reading or editing configuration. */
export function validateConnectionName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(name)) {
    throw new Error("Connection names must start with a letter and contain only letters, digits, underscores, or hyphens.");
  }
}

/** Generate or merge a single hub entry while keeping unrelated settings intact. */
export function mergeConnection(
  client: ConnectionClient, hub: string, tokenEnv?: string, existing = "", replace = false, name = "agent_tcdh",
): { content: string; notes: string[] } {
  // 1. Validate generated values and select the documented client-specific server format.
  connectionClientSchema.parse(client);
  validateConnectionName(name);
  if (tokenEnv !== undefined) {
    envNameSchema.parse(tokenEnv);
  }
  const url = normalizeHub(hub) + "/mcp";
  const entry = client === "codex"
    ? { url, ...(tokenEnv ? { bearer_token_env_var: tokenEnv } : {}) }
    : usesBridge(client) ? bridgeEntry(client, hub, tokenEnv)
      : { type: "remote", url, oauth: false, ...(tokenEnv ? { headers: { Authorization: "Bearer {env:" + tokenEnv + "}" } } : {}) };

  // 2. Preserve TOML text when appending; require explicit replacement before normalization or a collision.
  if (client === "codex") {
    const root = toml(existing);
    const servers = root.mcp_servers === undefined ? {} : object(root.mcp_servers);
    const previous = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (previous !== undefined && sameValue(previous, entry)) {
      return { content: existing, notes: [] };
    }
    if (previous !== undefined && !replace) {
      throw new ConfigurationFileError("This hub entry already exists with different settings. Use --replace to update only the named server.");
    }
    root.mcp_servers = { ...servers, [name]: entry };
    const start = "# AgentTCDH begin " + name;
    const end = "# AgentTCDH end " + name;
    const fragment = start + "\n[mcp_servers." + JSON.stringify(name) + "]\n"
      + stringifyToml(entry).trimEnd() + "\n" + end;
    let candidate: string | undefined;
    const startAt = existing.indexOf(start + "\n");
    const endAt = existing.indexOf(end, startAt);
    if (previous !== undefined && replace && startAt >= 0 && endAt > startAt) {
      candidate = existing.slice(0, startAt) + fragment + existing.slice(endAt + end.length);
    } else if (previous === undefined) {
      candidate = (existing.trimEnd() ? existing.trimEnd() + "\n\n" : "") + fragment + "\n";
    }
    if (candidate !== undefined) {
      try {
        if (sameValue(parseToml(candidate), root)) {
          return { content: candidate, notes: [] };
        }
      } catch {
        // Inline TOML tables cannot be extended with an appended table declaration.
      }
    }
    if (!replace) {
      throw new ConfigurationFileError("This TOML layout requires normalization. Use --replace after previewing; writing keeps an exact backup.");
    }
    return { content: stringifyToml(root), notes: ["TOML formatting and comments are normalized; the original file is preserved in the backup."] };
  }

  // 3. Edit JSONC at the exact server path, preserving comments, the BOM, and neighboring settings.
  const { root, servers, path, bom, text } = connectionDocument(client, existing, name);
  const expected = structuredClone(root);
  let parent = expected;
  for (const key of path.slice(0, -1)) {
    parent[key] ??= {};
    parent = object(parent[key]);
  }
  parent[name] = entry;
  const previous = Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (previous !== undefined && sameValue(previous, entry)) {
    return { content: bom + text, notes: [] };
  }
  if (previous !== undefined && !replace) {
    throw new ConfigurationFileError("This hub entry already exists with different settings. Use --replace to update only the named server.");
  }
  const content = applyEdits(text, modify(text, path, entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
  const validation: ParseError[] = [];
  const actual = parseJsonc(content, validation, { allowTrailingComma: true });
  if (validation.length || !sameValue(actual, expected)) {
    throw new ConfigurationFileError("Unable to merge this JSONC layout. Use the generated fragment instead.");
  }
  return { content: bom + content + (content.endsWith("\n") ? "" : "\n"), notes: [] };
}

/** Preview a hub configuration or explicitly merge it into a chosen file with a backup. */
export async function connectClient(options: {
  client: string; hub: string; tokenEnv?: string | undefined; write?: string | undefined;
  replace?: boolean | undefined; name?: string | undefined; dryRun?: boolean | undefined; plan?: boolean | undefined;
}) {
  const client = connectionClientSchema.parse(options.client);
  if (usesBridge(client)) {
    try {
      await access(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));
    } catch {
      throw new Error("Build the CLI with npm run build before generating a local bridge connection.");
    }
  }
  const existing = options.write ? await readConfigText(options.write) : undefined;
  const generated = mergeConnection(client, options.hub, options.tokenEnv, undefined, false, options.name).content;
  const dryRun = Boolean(options.dryRun || options.plan);
  const merged = options.write ? mergeConnection(client, options.hub, options.tokenEnv, existing, options.replace || options.plan, options.name)
    : { content: generated, notes: [] };
  const plan = options.write ? connectionPlan(client, options.name ?? "agent_tcdh", generated, existing, options.write,
    Boolean(merged.notes.length)) : undefined;
  const result = options.write && !dryRun ? await writeConfigText(options.write, merged.content, existing)
    : { changed: merged.content !== existing, ...(options.write ? { path: options.write } : {}) };
  return { client, hub: normalizeHub(options.hub), ...result, dryRun,
    ...(plan ? { plan } : {}), ...(!options.write || dryRun ? { content: generated } : {}), transport: usesBridge(client) ? "stdio" : "streamable-http",
    notes: [...merged.notes, ...(usesBridge(client) ? ["This profile launches the existing local discovery bridge. Generated Node/package paths belong to this machine; regenerate after moving the installation or changing execution environments."] : [])],
    requiredEnvironmentVariables: options.tokenEnv ? [options.tokenEnv] : [],
    instructions: "Use AgentTCDH search_targets to find capabilities, then get_target to retrieve current connection details. "
      + "Connect directly to the selected MCP server or A2A agent using this client's protocol support, target credentials, and execution permissions. "
      + "The hub supplies metadata; native dynamic tool mounting depends on the client. Restart or reload the client after applying its configuration.",
  };
}

/** Inspect a chosen client file against this installation's generated profile without writes or execution. */
export async function checkConnection(options: {
  client: string; hub: string; file: string; tokenEnv?: string | undefined; name?: string | undefined;
}) {
  // 1. Generate and validate the expected entry, then read only the explicitly selected client file.
  if (!options.file.trim()) {
    throw new Error("--check requires a non-empty client configuration file path.");
  }
  const client = connectionClientSchema.parse(options.client);
  const name = options.name ?? "agent_tcdh";
  const generated = mergeConnection(client, options.hub, options.tokenEnv, "", false, name).content;
  const existing = await readConfigText(options.file);
  const { reason, differingFields } = compareConnection(client, name, generated, existing);
  return { client, hub: normalizeHub(options.hub), name, path: resolve(options.file),
    status: reason === "matched" ? "passed" : "failed", reason, differingFields,
    changed: false, executionVerified: false, transport: usesBridge(client) ? "stdio" : "streamable-http",
    requiredEnvironmentVariables: options.tokenEnv ? [options.tokenEnv] : [],
    action: reason === "matched" ? "Configuration matches the generated profile. Reload the client if it has not loaded these settings."
      : reason === "settings-differ" ? "Review connect --print and connect --write FILE --dry-run --replace before updating this named entry."
        : "Review connect --write FILE --dry-run, then use --write FILE to add the named hub entry.",
    scope: "Local configuration comparison only. Client loading, credential values, hub access, and target execution were not verified.",
  };
}

/** Report only recognized field names and a marker for additional settings. */
function compareConnection(client: ConnectionClient, name: string, generated: string, existing: string | undefined) {
  const expected = connectionDocument(client, generated, name).servers[name];
  const document = existing === undefined ? undefined : connectionDocument(client, existing, name);
  const present = document !== undefined && Object.hasOwn(document.servers, name);
  const actual = present ? document!.servers[name] : undefined;

  // 2. Report only known field names; never copy source settings, arbitrary keys, or credential values.
  const known = ["url", "bearer_token_env_var", "type", "command", "args", "env", "headers", "oauth"];
  let differingFields: string[] = [];
  if (present && !sameValue(actual, expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      differingFields = ["entry"];
    } else {
      const actualEntry = actual as Record<string, unknown>;
      const expectedEntry = expected as Record<string, unknown>;
      differingFields = known.filter((key) => !sameValue(actualEntry[key], expectedEntry[key]));
      if (Object.keys(actualEntry).some((key) => !known.includes(key))) {
        differingFields.push("additional-settings");
      }
    }
  }
  const reason = existing === undefined ? "file-missing" : !present ? "entry-missing"
    : sameValue(actual, expected) ? "matched" : "settings-differ";
  return { reason, differingFields };
}

function connectionPlan(client: ConnectionClient, name: string, generated: string, existing: string | undefined, file: string, normalize: boolean) {
  const { reason, differingFields } = compareConnection(client, name, generated, existing);
  return { action: reason === "matched" ? "unchanged" : reason === "settings-differ" ? "replace" : "add", path: resolve(file), name,
    differingFields, requiresReplace: reason === "settings-differ" || normalize, normalizesFile: normalize };
}
