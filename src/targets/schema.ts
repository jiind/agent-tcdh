import { z } from "zod";

const label = z.string().trim().min(1).max(200);
export const httpUrl = z.string().max(4096).refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}, "Enter an HTTP(S) URL without credentials or a fragment.");

export const targetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const protocolSchema = z.enum(["mcp", "a2a"]);
export const a2aBindingSchema = z.enum(["JSONRPC", "HTTP+JSON"]).describe("Protocol binding of the selected A2A HTTP interface");
export const a2aVersionSchema = z.string().max(64).regex(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/)
  .describe("Declared A2A version of the selected interface, such as 1.0 or 0.3.0");
export const capabilitySchema = z.strictObject({
  name: label,
  description: z.string().trim().max(4000).default(""),
  inputSchema: z.record(z.string(), z.json()).optional(),
});

const authTypeSchema = z.enum(["none", "bearer", "api-key", "oauth2"]);
const authSchema = z.strictObject({
  type: authTypeSchema,
  description: z.string().trim().max(2000).optional(),
  envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50).default([]),
});

const stdioConnection = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(100).default([]),
  envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50).default([]),
});

const mcpRemoteConnection = z.strictObject({
  transport: z.enum(["streamable-http", "sse"]),
  url: httpUrl,
  auth: authSchema.optional(),
});

const a2aConnection = z.strictObject({
  transport: z.literal("http"),
  url: httpUrl,
  agentCardUrl: httpUrl.optional(),
  protocolBinding: a2aBindingSchema.optional(),
  protocolVersion: a2aVersionSchema.optional(),
  auth: authSchema.optional(),
});
const transportSchema = z.enum([stdioConnection.shape.transport.value,
  ...mcpRemoteConnection.shape.transport.options, a2aConnection.shape.transport.value]);

const commonFields = {
  id: targetIdSchema,
  name: label,
  description: z.string().trim().min(1).max(8000),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  aliases: z.array(label).max(30).optional(),
  capabilities: z.array(capabilitySchema).max(200).default([]),
  enabled: z.boolean().default(true),
};

const mcpDefinitionSchema = z.strictObject({
  ...commonFields,
  protocol: z.literal("mcp"),
  connection: z.union([stdioConnection, mcpRemoteConnection]),
});
const a2aDefinitionSchema = z.strictObject({
  ...commonFields,
  protocol: z.literal("a2a"),
  connection: a2aConnection,
});

export const targetDefinitionSchema = z.discriminatedUnion("protocol", [
  mcpDefinitionSchema,
  a2aDefinitionSchema,
]).superRefine((target, context) => {
  const names = target.capabilities.map((capability) => capability.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Capability names must be unique within a target.",
    });
  }
});

export const searchFields = {
  q: z.string().trim().max(500).default(""),
  match: z.literal("normalized").optional().describe("Normalize Unicode, whitespace, hyphens, and underscores before matching every search term"),
  protocol: protocolSchema.optional(),
  tag: z.string().trim().min(1).max(100).optional(),
  includeDisabled: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
};

export const searchSchema = z.strictObject(searchFields);
export const freshnessStateSchema = z.enum(["unknown", "changed", "stale", "fresh"]);
export const discoverySearchFields = {
  ...searchFields,
  suggest: z.boolean().optional().describe("Return separate suggestions missing one term when the first page has no complete matches"),
  transport: transportSchema.optional().describe("Filter by the registered target transport"),
  auth: authTypeSchema.optional().describe("Filter by declared remote authentication type. 'none' includes remote targets with no auth entry."),
  view: z.literal("summary").optional().describe("Return compact target summaries with matched capabilities. Use get_target for full metadata."),
  explain: z.boolean().optional(),
  inputs: z.boolean().optional().describe("Include required input names and declared types in capability summaries"),
  freshness: freshnessStateSchema.optional(),
  withFreshness: z.boolean().optional(),
  staleHours: z.number().min(0).max(8760).optional(),
  cursor: z.string().min(1).max(512).optional().describe("Use start for the first snapshot-checked page"),
};
export const discoverySearchSchema = z.strictObject(discoverySearchFields);
const timestamps = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const targetSchema = z.discriminatedUnion("protocol", [
  mcpDefinitionSchema.extend(timestamps),
  a2aDefinitionSchema.extend(timestamps),
]);
export const targetLookupLimits = { ids: 10, definitionBytes: 4 * 1024 * 1024 };
export const targetLookupSchema = z.strictObject({
  ids: z.array(targetIdSchema).min(1).max(targetLookupLimits.ids)
    .refine((ids) => new Set(ids).size === ids.length, "Target IDs must be unique.")
    .meta({ uniqueItems: true, description: "Unique target IDs in the requested result order" }),
});
export const targetLookupResultSchema = z.strictObject({
  items: z.array(z.strictObject({ id: targetIdSchema, target: targetSchema.nullable() })).min(1).max(targetLookupLimits.ids),
});
const searchPageFields = {
  total: z.number().int().nonnegative(),
  limit: searchFields.limit,
  offset: searchFields.offset,
  nextCursor: z.string().nullable().optional(),
  freshness: z.array(z.strictObject({ id: targetIdSchema, state: freshnessStateSchema, checkedAt: z.iso.datetime().nullable(),
    status: z.enum(["unknown", "passed", "warning", "failed", "skipped"]) })).optional(),
  explanations: z.array(z.strictObject({ id: targetIdSchema, terms: z.array(z.strictObject({ term: z.string(),
    fields: z.array(z.string()) })) })).optional(),
  exclusions: z.record(z.string(), z.number().int().nonnegative()).optional(),
};

export const searchSummaryLimits = { targetDescription: 240, capabilityDescription: 160, matchedCapabilities: 3 };
export const searchSuggestionLimit = 3;
const searchSummaryItemSchema = z.strictObject({
  id: targetIdSchema,
  name: label,
  protocol: protocolSchema,
  transport: transportSchema,
  authType: authTypeSchema.optional().describe("Declared remote authentication type. Omitted for stdio targets."),
  enabled: z.boolean(),
  description: z.string().max(searchSummaryLimits.targetDescription),
  capabilityCount: z.number().int().min(0).max(200),
  matchedCapabilities: z.array(z.strictObject({
    name: label,
    description: z.string().max(searchSummaryLimits.capabilityDescription),
    requiredInputs: z.array(z.strictObject({ name: z.string(), type: z.string().nullable() })).max(12).nullable().optional(),
    requiredInputCount: z.number().int().nonnegative().optional(),
  })).max(searchSummaryLimits.matchedCapabilities),
});
const searchSuggestionSchema = searchSummaryItemSchema.extend({ missingTerm: z.string().min(1) });
const searchSuggestions = z.array(searchSuggestionSchema).max(searchSuggestionLimit).optional();
export const searchResultSchema = z.strictObject({ items: z.array(targetSchema), ...searchPageFields, suggestions: searchSuggestions });
export const searchSummaryResultSchema = z.strictObject({
  view: z.literal("summary"),
  items: z.array(searchSummaryItemSchema).max(100),
  ...searchPageFields,
  suggestions: searchSuggestions,
});
const searchQueryBoolean = z.enum(["true", "false"]).transform((value) => value === "true").optional();
export const searchQuerySchema = z.strictObject({
  ...discoverySearchFields,
  includeDisabled: searchQueryBoolean,
  suggest: searchQueryBoolean,
  explain: searchQueryBoolean,
  inputs: searchQueryBoolean,
  withFreshness: searchQueryBoolean,
  staleHours: z.coerce.number().min(0).max(8760).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
}).transform((value) => discoverySearchSchema.parse(value));

export type TargetDefinition = z.infer<typeof targetDefinitionSchema>;
export type Target = z.infer<typeof targetSchema>;
export type TargetLookupResult = z.infer<typeof targetLookupResultSchema>;
export type DiscoverySearchOptions = z.infer<typeof discoverySearchSchema>;
export type SearchOptions = Omit<DiscoverySearchOptions, "view"> & { view?: undefined };
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchSummaryItem = z.infer<typeof searchSummaryItemSchema>;
export type SearchSummaryResult = z.infer<typeof searchSummaryResultSchema>;
export type DiscoverySearchResult = SearchResult | SearchSummaryResult;
