import { parseDocument } from "yaml";
import { z } from "zod";
import { agentCardSchema, selectA2aInterface } from "../targets/a2a.js";
import { targetDefinitionSchema } from "../targets/schema.js";
import type { TargetDefinition } from "../targets/schema.js";
import { envNameSchema } from "./config.js";
import type { ImportIssue } from "./import-config.js";

export type LocalAgent = { name: string; definition: Record<string, unknown> };

/** Read Gemini remote-agent YAML frontmatter without executing tags, aliases, commands, or Markdown instructions. */
export function localAgents(text: string): LocalAgent[] {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) {
    throw new Error("Expected bounded YAML agent frontmatter.");
  }
  const document = parseDocument(match[1]!, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error("Invalid or unsupported YAML agent frontmatter.");
  }
  const parsed: unknown = document.toJS({ maxAliasCount: 0 });
  const definitions = Array.isArray(parsed) ? parsed : [parsed];
  if (definitions.length > 100) {
    throw new Error("At most 100 agents may be declared per file.");
  }
  const agents: LocalAgent[] = [];
  for (const value of definitions) {
    const definition = z.record(z.string(), z.unknown()).parse(value);
    if (definition.kind !== "remote") {
      if (Array.isArray(parsed)) {
        throw new Error("Agent lists must contain remote agents only.");
      }
      continue;
    }
    const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,199}$/u).parse(definition.name);
    if (agents.some((agent) => agent.name === name)) {
      throw new Error("Duplicate remote agent names in one source.");
    }
    agents.push({ name, definition });
  }
  return agents;
}

/** Reject endpoint interpolation and embedded credential-bearing URL components without resolving any values. */
export function localHttpUrl(value: unknown): string {
  const text = z.string().max(4096).parse(value);
  if (/[${}]/u.test(text)) {
    throw new Error("Endpoint substitutions require explicit configuration.");
  }
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP endpoint without credentials, queries, or fragments.");
  }
  return url.href;
}

/** Preserve only Gemini's declared Bearer environment reference, never dynamic commands or stored credential values. */
export function localAgentAuth(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const auth = z.object({ type: z.literal("http"), scheme: z.string().regex(/^Bearer$/iu), token: z.string() }).strict().parse(input);
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(auth.token);
  if (!match) {
    throw new Error("Only a Bearer environment reference is portable.");
  }
  return envNameSchema.parse(match[1]);
}

/** Convert an inline Gemini A2A card using its declared execution interface rather than the card's location. */
export function inlineAgentTarget(agent: LocalAgent, id: string, bearerEnv: string | undefined): TargetDefinition {
  const card = agentCardSchema.parse(JSON.parse(z.string().parse(agent.definition.agent_card_json)));
  const selected = selectA2aInterface(card);
  localHttpUrl(selected.url);
  return targetDefinitionSchema.parse({ id, name: agent.name, description: card.description,
    protocol: "a2a", tags: ["imported-local"], capabilities: card.skills.map((skill) => ({ name: skill.id, description: skill.description || skill.name || "" })),
    connection: { transport: "http", ...selected, ...(bearerEnv ? { auth: { type: "bearer", envVars: [bearerEnv] } } : {}) } });
}

/** Describe a card lookup prerequisite without pretending a metadata URL is an execution endpoint. */
export function cardLookupIssue(name: string): ImportIssue {
  return { name, code: "A2A_CARD_FETCH_REQUIRED", severity: "error",
    message: "Only the Agent Card URL is declared. Select this entry and use --fetch-a2a-cards to inspect its execution interface." };
}
