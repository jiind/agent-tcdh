import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PACKAGE_VERSION } from "./version.js";
import { HubClient } from "./client.js";
import { discoverySearchFields, discoverySearchSchema, targetIdSchema, targetLookupSchema } from "./targets/schema.js";
import type { DiscoverySearchOptions, DiscoverySearchResult, Target, TargetLookupResult } from "./targets/schema.js";

export interface DiscoveryReader {
  search(options: DiscoverySearchOptions): DiscoverySearchResult | Promise<DiscoverySearchResult>;
  get(id: string): Target | Promise<Target>;
  getMany(ids: string[]): TargetLookupResult | Promise<TargetLookupResult>;
}

/** Configure read-only MCP discovery tools that query current registry data on every call. */
export function createDiscoveryServer(client: DiscoveryReader): McpServer {
  // 1. Explain discovery and direct connections to the consuming agent.
  const server = new McpServer(
    { name: "agent-tcdh", version: PACKAGE_VERSION },
    {
      instructions: "Use search_targets to find capabilities. Use get_target for one selection or get_targets for several. "
        + "Connect directly using the returned connection protocol, URL, or executable command. "
        + "This server returns registered metadata and does not execute target tools.",
    },
  );

  // 2. Register search and lookup tools backed by the common HTTP client.
  server.registerTool("search_targets", {
    description: "Search registered MCP servers and A2A agents by capability, description, tag, or alias. "
      + "Use view='summary' to compare candidates and matched capabilities, then get_target or get_targets for connection details and full schemas. "
      + "Filter by target transport or declared remote auth when the consumer requires a specific connection. "
      + "All search terms must match; only enabled targets are returned by default. Use match='normalized' for Unicode or separator differences. "
      + "Use inputs=true for required parameter previews in summaries, explain=true for match or exclusion details, "
      + "and cursor='start' for change-aware pagination. Set suggest=true for separate candidates missing one term.",
    inputSchema: discoverySearchFields,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    return toolResult(async () => client.search(discoverySearchSchema.parse(input)));
  });
  server.registerTool("get_target", {
    description: "Get current capabilities and direct connection details for a target id.",
    inputSchema: { id: targetIdSchema.describe("Target id") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ id }) => {
    return toolResult(async () => client.get(id));
  });
  server.registerTool("get_targets", {
    description: "Get complete metadata for up to ten unique target IDs in one lookup. Results follow the request order and use null for missing targets.",
    inputSchema: targetLookupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ ids }) => {
    return toolResult(async () => client.getMany(ids));
  });

  return server;
}

/** Return HTTP failures as tool errors without closing the protocol connection. */
async function toolResult(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Hub query failed" }],
    };
  }
}

/** Serve discovery over stdio and clean up the MCP connection on shutdown. */
export async function runDiscoveryServer(client: HubClient): Promise<void> {
  // 1. Connect the client to the MCP transport.
  const server = createDiscoveryServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 2. Handle stdin completion and process termination signals.
  const close = async () => {
    await server.close();
  };
  process.stdin.once("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
