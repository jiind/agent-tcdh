import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { inspectRemote, remoteImportSchema } from "../remote-import.js";
import type { TargetDefinition } from "../targets/schema.js";
import { envNameSchema } from "./config.js";
import { readConfigText } from "./files.js";
import { importedId, importPrefixSchema, prepareConfigImport, preparedSnapshot, requiredVariables } from "./import-config.js";
import type { ImportIssue } from "./import-config.js";
import { cardLookupIssue, inlineAgentTarget, localAgentAuth, localAgents, localHttpUrl } from "./local-a2a.js";
import type { LocalAgent } from "./local-a2a.js";
import { expandLocalSources, localSourceLocations } from "./local-sources.js";
import type { LocalSource, LocalSourceOptions } from "./local-sources.js";

interface Entry {
  key: string;
  source: string;
  name: string;
  protocol: "mcp" | "a2a";
  selected: boolean;
  status: "unselected" | "ready" | "blocked" | "duplicate" | "excluded";
  targetId?: string;
  duplicateOf?: string;
  metadataInspected: boolean;
}
interface Candidate {
  entry: Entry;
  source: LocalSource;
  value: unknown;
  format: "codex" | "opencode" | "opencode-v1" | "mcp-json";
}
export interface LocalImportOptions extends LocalSourceOptions {
  select?: string[] | undefined;
  prefix?: string | undefined;
  hub?: string | undefined;
  fetchA2aCards?: boolean | undefined;
}

/** Require an ordinary configuration object while suppressing parser output that could contain source values. */
function object(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

/** Parse exactly one known client container, including Claude's selected project-local declarations. */
function mcpEntries(text: string, source: LocalSource, project: string) {
  let root: Record<string, unknown>;
  if (source.client === "codex") {
    root = object(parseToml(text.replace(/^\uFEFF/u, "")));
    return { entries: object(root.mcp_servers ?? {}), format: "codex" as const };
  }
  const errors: ParseError[] = [];
  root = object(parseJsonc(text.replace(/^\uFEFF/u, ""), errors, { allowTrailingComma: true }));
  if (errors.length) {
    throw new Error("Invalid JSON/JSONC syntax.");
  }
  if (source.client === "claude-code" && source.scope === "local") {
    root = object(object(root.projects ?? {})[project] ?? {});
  }
  if (source.client === "opencode") {
    const mcp = object(root.mcp ?? {});
    const nested = mcp.servers !== undefined && !["local", "remote"].includes(String(object(mcp.servers).type));
    return { entries: nested ? object(mcp.servers) : mcp, format: nested ? "opencode" as const : "opencode-v1" as const };
  }
  return { entries: object(root[source.client === "vscode" ? "servers" : "mcpServers"] ?? {}), format: "mcp-json" as const };
}

/** Normalize documented client transport and environment-reference fields into the existing portable MCP converter. */
function portableEntry(value: unknown, source: LocalSource): Record<string, unknown> {
  const entry = { ...object(value) };
  if (["codex", "opencode"].includes(source.client)) {
    return entry;
  }
  if (source.client === "gemini-cli") {
    if (entry.httpUrl !== undefined) {
      if (entry.url !== undefined || entry.command !== undefined || entry.type !== undefined) {
        throw new Error("Ambiguous Gemini transport.");
      }
      entry.url = entry.httpUrl;
      entry.type = "http";
    } else if (entry.url !== undefined) {
      if (entry.type !== undefined && entry.type !== "sse") {
        throw new Error("Gemini URL transport conflicts with its declared type.");
      }
      entry.type = "sse";
    }
  }
  if (source.client === "claude-code" && entry.url !== undefined && entry.type === undefined) {
    throw new Error("Claude remote entries require an explicit transport type.");
  }
  if (entry.type === "streamable-http") {
    entry.type = "http";
  }
  if (entry.includeTools !== undefined || entry.excludeTools !== undefined) {
    entry.tools = [];
  }
  if (entry.oauth !== undefined && entry.oauth !== false || entry.authProviderType !== undefined
    || entry.authProvider !== undefined || entry.sandbox !== undefined) {
    throw new Error("Client-managed authentication or execution context requires manual configuration.");
  }
  const environment: Record<string, unknown> = Object.create(null);
  const variables = z.array(z.string()).parse(entry.env_vars ?? []);
  for (const [name, raw] of Object.entries(object(entry.env ?? {}))) {
    const text = z.string().parse(raw);
    const match = source.client === "cursor" || source.client === "vscode"
      ? /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(text) : /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(text);
    if (match) {
      if (match[1] !== name) {
        throw new Error("Environment aliases cannot be represented by pass-through names.");
      }
      variables.push(envNameSchema.parse(name));
    } else {
      environment[name] = raw;
    }
  }
  if (entry.env !== undefined) {
    entry.env = environment;
  }
  if (variables.length) {
    entry.env_vars = [...new Set(variables)];
  }
  const headers = { ...object(entry.headers ?? {}) };
  for (const [name, value] of Object.entries(headers)) {
    const match = source.client === "cursor" || source.client === "vscode"
      ? /^Bearer \$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/iu.exec(String(value)) : /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/iu.exec(String(value));
    if (name.toLowerCase() === "authorization" && match) {
      if (entry.bearer_token_env_var !== undefined) {
        throw new Error("Conflicting Bearer references.");
      }
      entry.bearer_token_env_var = envNameSchema.parse(match[1]);
      delete headers[name];
    }
  }
  if (entry.headers !== undefined) {
    entry.headers = headers;
  }
  if (entry.url !== undefined) {
    localHttpUrl(entry.url);
  }
  return entry;
}

/** Discover local client declarations, prepare only selected entries, and optionally inspect explicitly requested A2A cards. */
export async function prepareLocalImport(input: LocalImportOptions, environment = process.env) {
  // 1. Validate selectors and enumerate bounded user/project sources without invoking any client.
  if (input.prefix !== undefined) {
    importPrefixSchema.parse(input.prefix);
  }
  const requested = input.select;
  if (requested && (!requested.length || requested.length > 1000 || new Set(requested).size !== requested.length)) {
    throw new Error("Select between 1 and 1000 unique local entry keys.");
  }
  const selectedKeys = requested === undefined ? undefined : new Set(requested);
  const locations = localSourceLocations(input, environment);
  const sources = await expandLocalSources(locations.sources);
  const sourceReports: (LocalSource & { status: "missing" | "empty" | "found" | "error"; entries: number })[] = [];
  const candidates: Candidate[] = [];
  const issues: ImportIssue[] = [];
  let bytes = 0;
  for (const source of sources) {
    const report = { ...source, status: "missing" as "missing" | "empty" | "found" | "error", entries: 0 };
    sourceReports.push(report);
    try {
      const text = await readConfigText(source.path);
      if (text === undefined) {
        continue;
      }
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > 8_388_608) {
        throw new Error("Local source byte budget exceeded.");
      }
      const parsed = source.kind === "a2a" ? { entries: Object.fromEntries(localAgents(text).map((agent) => [agent.name, agent])), format: "mcp-json" as const }
        : mcpEntries(text, source, locations.project);
      const entries = Object.entries(parsed.entries);
      report.status = entries.length ? "found" : "empty";
      report.entries = entries.length;
      for (const [name, value] of entries) {
        const key = source.id + "/" + encodeURIComponent(name);
        candidates.push({ source, value, format: parsed.format, entry: { key, source: source.id, name,
          protocol: source.kind === "a2a" ? "a2a" : "mcp", selected: selectedKeys === undefined || selectedKeys.has(key),
          status: "unselected", metadataInspected: false } });
      }
    } catch {
      report.status = "error";
      issues.push({ name: source.id, code: "LOCAL_SOURCE_UNREADABLE", severity: requested ? "warning" : "error",
        message: "This source is invalid, linked, oversized, or unreadable. Narrow the selection or fix it; source contents were not printed." });
    }
    if (bytes > 8_388_608 || candidates.length > 10_000) {
      throw new Error("Local import exceeds 8 MiB of configuration text or 10000 entries. Narrow --client/--scope.");
    }
  }
  const availableKeys = new Set(candidates.map((candidate) => candidate.entry.key));
  if (requested?.some((key) => !availableKeys.has(key))) {
    throw new Error("Selections must name discovered local entry keys. Preview the same scope before selecting.");
  }

  // 2. Reuse the MCP converter and keep card-location-only A2A entries pending until an explicit network choice.
  const prepared: { entry: Entry; target: TargetDefinition }[] = [];
  const pending: { entry: Entry; agent: LocalAgent; id: string; url: string; bearerEnv?: string | undefined }[] = [];
  for (const candidate of candidates.filter((item) => item.entry.selected)) {
    const { entry, source } = candidate;
    entry.status = "blocked";
    const id = importedId(entry.key, input.prefix);
    try {
      if (source.kind === "a2a") {
        const agent = candidate.value as LocalAgent;
        const bearerEnv = localAgentAuth(agent.definition.auth);
        const hasUrl = agent.definition.agent_card_url !== undefined;
        const hasInline = agent.definition.agent_card_json !== undefined;
        if (hasUrl === hasInline) {
          throw new Error("Choose one card representation.");
        }
        if (hasUrl) {
          pending.push({ entry, agent, id, url: localHttpUrl(agent.definition.agent_card_url), bearerEnv });
        } else {
          prepared.push({ entry, target: inlineAgentTarget(agent, id, bearerEnv) });
        }
      } else {
        const normalized = portableEntry(candidate.value, source);
        const name = entry.name;
        const container = Object.fromEntries([[name, normalized]]);
        const document = candidate.format === "opencode" ? { mcp: { servers: container } }
          : candidate.format === "opencode-v1" ? { mcp: container } : { mcpServers: container };
        // Codex's converter is retained by serializing its selected table with the existing TOML writer.
        const text = candidate.format === "codex" ? await codexEntryText(name, normalized) : JSON.stringify(document);
        const conversion = prepareConfigImport(text, { format: candidate.format, hub: input.hub });
        issues.push(...conversion.issues.map((issue) => ({ ...issue, name: entry.key })));
        if (conversion.ready) {
          const target = conversion.targets[0]!;
          if (target.connection.transport !== "stdio" && conversion.issues.some((issue) => issue.code === "INLINE_BEARER_OMITTED")) {
            target.connection.auth = { type: "bearer", envVars: ["MCP_" + id.toUpperCase().replace(/[^A-Z0-9_]/gu, "_") + "_TOKEN"] };
          }
          prepared.push({ entry, target: { ...target, id, tags: [...target.tags, "imported-local"] } });
        } else if (conversion.issues.some((issue) => issue.code === "HUB_SELF_REFERENCE")) {
          entry.status = "excluded";
        }
      }
    } catch {
      issues.push({ name: entry.key, code: "LOCAL_ENTRY_UNSUPPORTED", severity: "error",
        message: "The selected declaration cannot be represented portably. Review its client format, transport, auth, or execution context." });
    }
  }
  if (!input.fetchA2aCards) {
    issues.push(...pending.map((item) => cardLookupIssue(item.entry.key)));
  } else if (pending.length > 10) {
    issues.push({ name: "a2a", code: "A2A_LOOKUP_LIMIT", severity: "error", message: "Select at most 10 remote Agent Card lookups per import." });
  } else if (!issues.some((issue) => issue.severity === "error")) {
    for (const item of pending) {
      try {
        const target = await inspectRemote(remoteImportSchema.parse({ id: item.id, protocol: "a2a", url: item.url,
          name: item.agent.name, tags: ["imported-local"], bearerEnv: item.bearerEnv }), environment, 7500);
        localHttpUrl(target.connection.transport === "http" ? target.connection.url : undefined);
        item.entry.metadataInspected = true;
        prepared.push({ entry: item.entry, target });
      } catch {
        issues.push({ name: item.entry.key, code: "A2A_CARD_LOOKUP_FAILED", severity: "error",
          message: "Unable to inspect the declared Agent Card. Check its URL and provider credential; no target task was executed." });
      }
    }
  }

  // 3. Coalesce identical portable connections, retain every origin, and submit nothing until the caller explicitly applies.
  const unique: typeof prepared = [];
  const connections = new Map<string, (typeof prepared)[number]>();
  const order = new Map(candidates.map((candidate, index) => [candidate.entry, index]));
  const omittedValues = new Set(issues.filter((issue) => ["INLINE_ENV_OMITTED", "INLINE_BEARER_OMITTED"].includes(issue.code)).map((issue) => issue.name));
  for (const item of prepared.sort((left, right) => order.get(left.entry)! - order.get(right.entry)!)) {
    const signature = JSON.stringify(canonicalConnection({ protocol: item.target.protocol, enabled: item.target.enabled,
      connection: item.target.connection, capabilities: item.target.capabilities }));
    const duplicate = !omittedValues.has(item.entry.key) && connections.get(signature);
    item.entry.targetId = duplicate ? duplicate.target.id : item.target.id;
    item.entry.status = duplicate ? "duplicate" : "ready";
    if (duplicate) {
      item.entry.duplicateOf = duplicate.entry.key;
    } else {
      unique.push(item);
      if (!omittedValues.has(item.entry.key)) {
        connections.set(signature, item);
      }
    }
  }
  const targets = unique.map((item) => item.target);
  preparedSnapshot(targets);
  const selected = candidates.filter((candidate) => candidate.entry.selected).length;
  return { format: "local-clients", scope: locations.scope, project: locations.project, sources: sourceReports,
    entries: candidates.map((candidate) => candidate.entry), available: candidates.length, selected, converted: targets.length,
    ready: targets.length > 0 && !issues.some((issue) => issue.severity === "error")
      && candidates.every((candidate) => !candidate.entry.selected || candidate.entry.status !== "blocked"),
    targets, issues, requiredEnvironmentVariables: [...new Set([...requiredVariables(targets),
      ...pending.flatMap((item) => item.bearerEnv ? [item.bearerEnv] : [])])].sort(),
    metadataInspected: candidates.some((candidate) => candidate.entry.metadataInspected), executionVerified: false as const };
}

/** Order JSON object keys for bounded connection deduplication while retaining meaningful array order. */
function canonicalConnection(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalConnection);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonicalConnection(child)]));
  }
  return value;
}

/** Serialize one selected Codex table without inspecting or copying unrelated configuration values. */
async function codexEntryText(name: string, entry: Record<string, unknown>): Promise<string> {
  const { stringify } = await import("smol-toml");
  return stringify({ mcp_servers: Object.fromEntries([[name, entry]]) });
}
