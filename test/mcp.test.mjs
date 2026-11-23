// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDiscoveryServer } from "../dist/mcp.js";
import { HubClient } from "../dist/client.js";
import { definition, fixture, register } from "./helpers.mjs";

/** Decode text JSON returned by an MCP tool. */
function payload(result) {
  return JSON.parse(result.content.find((part) => part.type === "text").text);
}

test("MCP discovery preserves the connection when HTTP failures become tool errors", async (t) => {
  const server = createDiscoveryServer({
    search: async () => {
      throw new Error("HTTP 401 UNAUTHORIZED");
    },
    get: async () => definition(),
    getMany: async (ids) => ({ items: ids.map((id) => ({ id, target: null })) }),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "search_targets", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /401/);
  assert.equal(payload(await client.callTool({
    name: "get_target", arguments: { id: "docs" },
  })).id, "docs");
});

test("actual stdio MCP clients see current registry additions, updates, and deletions", async (t) => {
  const app = await fixture(t, { token: "mcp-secret" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = { authorization: "Bearer mcp-secret" };
  await register(app, definition(), headers);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js"), "mcp", "--hub", hub],
    env: { AGENT_TCDH_TOKEN: "mcp-secret" },
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "get_target", "get_targets", "search_targets",
  ]);

  const found = payload(await client.callTool({
    name: "search_targets", arguments: { q: "배포" },
  }));
  assert.equal(found.total, 1);
  assert.equal(found.items[0].connection.url, "http://127.0.0.1:1/mcp");
  assert.equal(payload(await client.callTool({
    name: "search_targets", arguments: { q: "배포_가이드" },
  })).total, 0);
  assert.equal(payload(await client.callTool({
    name: "search_targets", arguments: { q: "배포_가이드", match: "normalized" },
  })).items[0].id, "docs");
  const summary = payload(await client.callTool({ name: "search_targets",
    arguments: { q: "자료", view: "summary", transport: "streamable-http", auth: "none" } }));
  assert.equal(summary.view, "summary");
  assert.equal(summary.items[0].transport, "streamable-http");
  assert.equal(summary.items[0].authType, "none");
  assert.deepEqual(summary.items[0].matchedCapabilities, [{ name: "search_docs", description: "공식 자료 조사" }]);
  assert.equal(Object.hasOwn(summary.items[0], "connection"), false);
  assert.equal(payload(await client.callTool({
    name: "get_target", arguments: { id: "docs" },
  })).id, "docs");
  const batch = payload(await client.callTool({ name: "get_targets", arguments: { ids: ["unknown", "docs"] } }));
  assert.deepEqual(batch.items, [{ id: "unknown", target: null }, { id: "docs", target: found.items[0] }]);
  assert.equal((await client.callTool({ name: "get_targets", arguments: { ids: ["docs", "docs"] } })).isError, true);

  await app.inject({
    method: "PUT", url: "/api/targets/docs",
    payload: definition("docs", { enabled: false }), headers,
  });
  assert.equal(payload(await client.callTool({
    name: "search_targets", arguments: {},
  })).total, 0);
  assert.equal(payload(await client.callTool({
    name: "search_targets", arguments: { includeDisabled: true },
  })).total, 1);
  await app.inject({ method: "DELETE", url: "/api/targets/docs", headers });
  assert.equal(payload(await client.callTool({
    name: "search_targets", arguments: { includeDisabled: true },
  })).total, 0);
  assert.equal((await client.callTool({
    name: "get_target", arguments: { id: "docs" },
  })).isError, true);
});

test("hub clients reject connection URLs with embedded credentials", () => {
  for (const url of [
    "file:///tmp/registry", "https://user:secret@example.com", "https://example.com?token=secret",
  ]) {
    assert.throws(() => new HubClient(url), /HTTP\(S\)/);
  }
});
