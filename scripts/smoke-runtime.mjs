import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export { runCommand } from "./process-utils.mjs";

/** Ask the operating system for an available loopback port. */
export async function availablePort() {
  // 1. Allocate an unused port.
  const allocator = createServer();
  await new Promise((resolve, reject) => {
    allocator.once("error", reject);
    allocator.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = allocator.address().port;

  // 2. Close the allocation socket so the verification process can bind the port.
  await new Promise((resolve, reject) => {
    allocator.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

/** Wait within a deadline for the public health endpoint to become ready. */
export async function waitForHub(url, alive = () => true) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && alive()) {
    try {
      const response = await fetch(url + "/health", { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") {
        return;
      }
    } catch {
      // Retry startup connection failures only within the overall deadline.
    }
    await setTimeout(100);
  }
  throw new Error("The deployed hub did not become ready before the deadline.");
}

/** Validate the HTTP status and decode the JSON response. */
async function requestJson(url, path, token, method = "GET", body, expectedStatus = 200) {
  const response = await fetch(url + path, {
    method, signal: AbortSignal.timeout(5000),
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, method + " " + path + ": " + text);
  return JSON.parse(text);
}

/** Verify authentication, registration, MCP, and both A2A versions in a deployed artifact. */
export async function verifyRuntime(url, credentials, marker, existing = false) {
  // 1. Verify roles using isolated test credentials unrelated to operational tokens.
  const { adminToken, readToken } = credentials;
  await requestJson(url, "/api/targets", undefined, "GET", undefined, 401);
  const ids = { mcp: marker + "-mcp", a2a: marker + "-a2a" };
  const definitions = ["mcp", "a2a"].map((protocol) => ({
    id: ids[protocol], name: protocol === "mcp" ? "Runtime MCP" : "Runtime probe metadata services",
    description: "Deployment verification " + marker, protocol, tags: [marker],
    capabilities: protocol === "mcp" ? [{ name: "probe", description: "Read deployment metadata" }]
      : [{ name: "probe", description: "Read health" }, { name: "metadata", description: "List properties" }],
    connection: protocol === "mcp" ? { transport: "streamable-http", url: "http://127.0.0.1:1/mcp" }
      : { transport: "http", url: "http://127.0.0.1:1/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0",
        auth: { type: "bearer", envVars: ["RUNTIME_TARGET_TOKEN"] } },
  }));
  await requestJson(url, "/api/targets", readToken, "POST", definitions[0], 403);
  if (!existing) {
    for (const definition of definitions) {
      await requestJson(url, "/api/targets", adminToken, "POST", definition, 201);
    }
  }
  const q = "probe metadata";
  const searchPath = "/api/targets?" + new URLSearchParams({ q, tag: marker });
  const http = await requestJson(url, searchPath, readToken);
  assert.equal(http.total, 2);
  assert.deepEqual(http.items.map((item) => item.id), [ids.mcp, ids.a2a]);
  const summary = await requestJson(url, searchPath + "&view=summary", readToken);
  assert.equal(summary.view, "summary");
  assert.deepEqual(summary.items.map((item) => item.id), http.items.map((item) => item.id));
  assert.ok(summary.items.every((item) => !Object.hasOwn(item, "connection") && item.matchedCapabilities[0].name === "probe"));
  const filteredArgs = { q, tag: marker, view: "summary", transport: "http", auth: "bearer" };
  const filtered = await requestJson(url, "/api/targets?" + new URLSearchParams(filteredArgs), readToken);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, ids.a2a);
  assert.equal(filtered.items[0].transport, "http");
  assert.equal(filtered.items[0].authType, "bearer");
  assert.doesNotMatch(JSON.stringify(filtered), /RUNTIME_TARGET_TOKEN/);
  const explainArgs = { ...filteredArgs, explain: true, inputs: true, freshness: "unknown", cursor: "start" };
  const explained = await requestJson(url, "/api/targets?" + new URLSearchParams(explainArgs), readToken);
  assert.equal(explained.nextCursor, null);
  assert.equal(explained.freshness[0].state, "unknown");
  assert.equal(explained.explanations[0].id, ids.a2a);
  assert.ok(explained.explanations[0].terms.every(({ fields }) => fields.length));
  assert.equal(explained.items[0].matchedCapabilities[0].requiredInputs, null);
  const suggestionArgs = { ...filteredArgs, q: q + " archival", suggest: true };
  const suggested = await requestJson(url, "/api/targets?" + new URLSearchParams({ ...suggestionArgs, suggest: "true" }), readToken);
  assert.equal(suggested.total, 0);
  assert.deepEqual(suggested.items, []);
  assert.deepEqual(suggested.suggestions.map(({ id, missingTerm }) => [id, missingTerm]), [[ids.a2a, "archival"]]);
  const missing = marker + "-missing";
  const selection = { ids: [ids.a2a, missing, ids.mcp] };
  await requestJson(url, "/api/targets/lookup", undefined, "POST", selection, 401);
  const details = await requestJson(url, "/api/targets/lookup", readToken, "POST", selection);
  assert.deepEqual(details.items, [{ id: ids.a2a, target: http.items[1] }, { id: missing, target: null }, { id: ids.mcp, target: http.items[0] }]);

  // 2. Connect with a read token and verify HTTP MCP discovery and connection metadata.
  const mcp = new Client({ name: "deployment-probe", version: "1.0.0" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + readToken } },
    }));
    const search = await mcp.callTool({ name: "search_targets", arguments: { tag: marker, view: "summary", q } });
    assert.deepEqual(JSON.parse(search.content[0].text), summary);
    const filteredSearch = await mcp.callTool({ name: "search_targets", arguments: filteredArgs });
    assert.deepEqual(JSON.parse(filteredSearch.content[0].text), filtered);
    const suggestedSearch = await mcp.callTool({ name: "search_targets", arguments: suggestionArgs });
    assert.deepEqual(JSON.parse(suggestedSearch.content[0].text), suggested);
    const explainedSearch = await mcp.callTool({ name: "search_targets", arguments: explainArgs });
    assert.deepEqual(JSON.parse(explainedSearch.content[0].text), explained);
    const found = await mcp.callTool({ name: "get_target", arguments: { id: ids.a2a } });
    assert.equal(JSON.parse(found.content[0].text).connection.protocolVersion, "1.0");
    const batch = await mcp.callTool({ name: "get_targets", arguments: selection });
    assert.deepEqual(JSON.parse(batch.content[0].text), details);
  } finally {
    await mcp.close();
  }

  // 3. Discover the public card and query A2A 1.0 and 0.3 with the official SDK.
  /** Apply the verification read token and timeout to every request. */
  const authenticatedFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer " + readToken);
    return fetch(input, { ...init, headers, signal: AbortSignal.timeout(5000) });
  };
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({
    fetchImpl: authenticatedFetch, legacyCompat: { enabled: true },
  })] });
  const client = await factory.createFromUrl(url);
  const card = await client.getAgentCard();
  assert.equal(card.supportedInterfaces[0].url, url + "/a2a");
  assert.equal(card.capabilities.streaming, false);
  assert.ok(Object.hasOwn(card.securitySchemes, "hubBearer"));
  const native = await client.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "get_target", arguments: { id: ids.a2a } } }],
  } }));
  assert.equal(Message.toJSON(native).parts[0].data.connection.protocolBinding, "JSONRPC");
  const legacy = await factory.createFromAgentCard({ ...card,
    supportedInterfaces: [{ ...card.supportedInterfaces[0], protocolVersion: "0.3" }],
  });
  for (const agent of [client, legacy]) {
    for (const [args, expected] of [[{ tag: marker, view: "summary", q }, summary], [filteredArgs, filtered],
      [suggestionArgs, suggested], [explainArgs, explained]]) {
      const found = await agent.sendMessage(SendMessageRequest.fromJSON({ message: {
        messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "search_targets", arguments: args } }],
      } }));
      assert.deepEqual(Message.toJSON(found).parts[0].data, expected);
    }
    const batch = await agent.sendMessage(SendMessageRequest.fromJSON({ message: {
      messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "get_targets", arguments: selection } }],
    } }));
    assert.deepEqual(Message.toJSON(batch).parts[0].data, details);
  }
  return { http: true, permissions: true, mcp: true, a2a10: true, a2a03: true, searchSummary: true, connectionFilters: true,
    batchLookup: true, searchSuggestions: true, explainedDiscovery: true };
}
