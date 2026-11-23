import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { PACKAGE_VERSION } from "./version.js";
import { a2aBindingSchema, a2aVersionSchema, httpUrl, protocolSchema, targetDefinitionSchema, targetIdSchema } from "./targets/schema.js";
import type { TargetDefinition } from "./targets/schema.js";
import { agentCardSchema, selectA2aInterface } from "./targets/a2a.js";
import type { A2aSelection } from "./targets/a2a.js";
import type { HubClient } from "./client.js";
import type { VersionedTarget } from "./targets/version.js";

export interface RefreshProposal {
  target: TargetDefinition;
  etag: string;
}

export const remoteImportSchema = z.strictObject({
  id: targetIdSchema,
  protocol: protocolSchema,
  url: httpUrl,
  transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(8000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  bearerEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  a2aBinding: a2aBindingSchema.optional(),
  a2aVersion: a2aVersionSchema.optional(),
}).superRefine((input, context) => {
  if (input.protocol !== "a2a" && (input.a2aBinding !== undefined || input.a2aVersion !== undefined)) {
    context.addIssue({ code: "custom", path: ["protocol"], message: "A2A binding and version selection is only available for A2A targets." });
  }
});
export type RemoteImportOptions = z.infer<typeof remoteImportSchema>;

/** Read remote metadata in the CLI process and convert it to a target definition. */
export async function inspectRemote(
  input: RemoteImportOptions,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<TargetDefinition> {
  // 1. Validate connection details and credential environment references.
  const options = remoteImportSchema.parse(input);
  const token = options.bearerEnv ? environment[options.bearerEnv] : undefined;
  if (options.bearerEnv && !token) {
    throw new Error("Required environment variable is missing: " + options.bearerEnv);
  }
  if (token && !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("Bearer tokens must be ASCII strings without whitespace or control characters.");
  }
  const url = new URL(options.url);
  if (options.protocol === "a2a" && url.pathname === "/") {
    url.pathname = "/.well-known/agent-card.json";
  }
  const auth = options.bearerEnv
    ? { type: "bearer" as const, envVars: [options.bearerEnv] } : undefined;

  // 2. Apply an overall timeout, response size limit, and same-origin policy.
  const signal = AbortSignal.timeout(timeoutMs);
  const request = createMetadataFetch(url, signal, token);

  // 3. Read public protocol metadata without executing tools.
  if (options.protocol === "mcp") {
    const metadata = await inspectMcp(options, url, request, signal, timeoutMs);
    return targetDefinitionSchema.parse({
      id: options.id, protocol: "mcp",
      name: options.name ?? metadata.name,
      description: options.description ?? metadata.name + " MCP server: " + metadata.capabilities.length + " tools",
      tags: options.tags,
      capabilities: metadata.capabilities,
      connection: {
        transport: options.transport, url: url.href,
        ...(auth ? { auth } : {}),
      },
    });
  }

  const response = await request(url, { headers: {
    Accept: "application/json",
    ...(options.a2aVersion === undefined ? {} : { "A2A-Version": options.a2aVersion }),
  } });
  if (!response.ok) {
    throw new Error("Agent Card request failed: HTTP " + response.status);
  }
  const card = agentCardSchema.parse(await response.json());
  const selected = selectA2aInterface(card, {
    protocolBinding: options.a2aBinding, protocolVersion: options.a2aVersion,
  });

  return targetDefinitionSchema.parse({
    id: options.id, protocol: "a2a",
    name: options.name ?? card.name,
    description: options.description ?? card.description,
    tags: options.tags,
    capabilities: card.skills.map((skill) => ({
      name: skill.id,
      description: skill.description || skill.name || "",
    })),
    connection: {
      transport: "http", ...selected, agentCardUrl: url.href,
      ...(auth ? { auth } : {}),
    },
  });
}

/** Read an allowed origin within the request timeout and response size limit. */
function createMetadataFetch(origin: URL, signal: AbortSignal, token?: string): typeof fetch {
  return async (input, init) => {
    // 1. Check the URL to prevent credential forwarding to other origins.
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin.origin) {
      throw new Error("Cross-origin metadata requests are not allowed.");
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (token) {
      headers.set("Authorization", "Bearer " + token);
    }
    const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;

    // 2. Disable automatic redirects and check the declared response size.
    const response = await fetch(input, { ...init, headers, redirect: "manual", signal: combined });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Use the final metadata URL instead of a redirect.");
    }
    const maxBytes = 1_048_576;
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("Metadata responses must not exceed 1 MiB.");
    }

    // 3. Apply the same limit to streams without a declared length.
    let bytes = 0;
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      /** Check accumulated chunk size before forwarding data. */
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          controller.error(new Error("Metadata responses must not exceed 1 MiB."));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(body ?? null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
}

/** Collect the server name and capabilities through MCP initialization and tool pagination. */
async function inspectMcp(
  options: RemoteImportOptions,
  url: URL,
  request: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
) {
  // 1. Connect the remote transport and retrieve the server name.
  const client = new Client({ name: "agent-tcdh-import", version: PACKAGE_VERSION });
  const transport = options.transport === "sse"
    ? new SSEClientTransport(url, { fetch: request })
    : new StreamableHTTPClientTransport(url, { fetch: request });
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    const info = client.getServerVersion();
    const name = info?.title ?? info?.name ?? "MCP server";
    const capabilities = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;

    // 2. Read all tool pages while rejecting repeated cursors and oversized lists.
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: timeoutMs });
      capabilities.push(...result.tools.map((tool) => ({
        name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema,
      })));
      if (capabilities.length > 200) {
        throw new Error("A target may register at most 200 capabilities.");
      }
      cursor = result.nextCursor;
      if (!cursor) {
        return { name, capabilities };
      }
      if (cursors.has(cursor)) {
        throw new Error("The MCP tool pagination cursor is repeated.");
      }
      cursors.add(cursor);
    }

    throw new Error("At most 50 MCP tool pages may be read.");
  } finally {
    // 3. Clean up the connection on both success and failure.
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      try {
        await transport.terminateSession();
      } catch {
        // Always close the local connection even if session deletion fails or times out.
      }
    }
    await client.close();
    await transport.close();
  }
}

/** Refresh remote capabilities while preserving administrator-defined labels and enabled state. */
export async function refreshDefinition(
  client: Pick<HubClient, "getVersioned">,
  id: string,
  bearerEnv?: string,
  selection: A2aSelection = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RefreshProposal> {
  // 1. Read the registered metadata URL and authentication references.
  const original = (await client.getVersioned(id)).target;
  if (original.connection.transport === "stdio") {
    throw new Error("Automatic refresh is not supported for stdio targets. Edit the JSON definition.");
  }
  const auth = original.connection.auth;
  if (!bearerEnv && auth?.type === "bearer" && auth.envVars.length > 1) {
    throw new Error("Select the credential environment variable using --bearer-env.");
  }
  const credentialEnv = bearerEnv ?? (auth?.type === "bearer" ? auth.envVars[0] : undefined);
  const inspected = await inspectRemote(remoteImportSchema.parse({
    id: original.id,
    protocol: original.protocol,
    url: original.protocol === "a2a"
      ? original.connection.agentCardUrl ?? original.connection.url : original.connection.url,
    transport: original.protocol === "mcp" ? original.connection.transport : undefined,
    bearerEnv: credentialEnv,
    a2aBinding: selection.protocolBinding ?? (original.protocol === "a2a" ? original.connection.protocolBinding : undefined),
    a2aVersion: selection.protocolVersion ?? (original.protocol === "a2a" ? original.connection.protocolVersion : undefined),
  }), environment);

  // 2. Reread administrator changes and stop if the connection changed.
  const current: VersionedTarget = await client.getVersioned(id);
  const latest = current.target;
  if (latest.protocol !== original.protocol
    || JSON.stringify(latest.connection) !== JSON.stringify(original.connection)) {
    throw new Error("Connection details changed during inspection. Retry using the current target.");
  }
  const connection = latest.protocol === "a2a" && inspected.protocol === "a2a"
    ? {
      ...latest.connection,
      url: inspected.connection.url,
      ...(inspected.connection.agentCardUrl ? { agentCardUrl: inspected.connection.agentCardUrl } : {}),
      ...(inspected.connection.protocolBinding ? { protocolBinding: inspected.connection.protocolBinding } : {}),
      ...(inspected.connection.protocolVersion ? { protocolVersion: inspected.connection.protocolVersion } : {}),
    }
    : latest.connection;

  // 3. Merge new capabilities and the A2A connection contract into the latest managed definition.
  const target = targetDefinitionSchema.parse({
    id: latest.id, name: latest.name, description: latest.description,
    protocol: latest.protocol, tags: latest.tags, ...(latest.aliases ? { aliases: latest.aliases } : {}), enabled: latest.enabled,
    capabilities: inspected.capabilities, connection,
  });
  return { target, etag: current.etag };
}
