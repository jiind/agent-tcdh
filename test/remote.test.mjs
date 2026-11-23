// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020.js";
import { serverOptionsSchema } from "../dist/server.js";
import { definition, fixture, register } from "./helpers.mjs";

const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "remote-test", version: "1.0.0" },
  },
};

/** Decode JSON data in an MCP tool response. */
function payload(result) {
  return JSON.parse(result.content.find((part) => part.type === "text").text);
}

test("HTTP MCP initialization responds with JSON without creating sessions", async (t) => {
  const app = await fixture(t);
  const response = await app.inject({ method: "POST", url: "/mcp", headers, payload: initialize });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /application\/json/);
  assert.equal(response.headers["mcp-session-id"], undefined);
  assert.equal(response.json().result.serverInfo.name, "agent-tcdh");
  assert.deepEqual(Object.keys(response.json().result.capabilities), ["tools"]);

  for (const method of ["GET", "DELETE"]) {
    const unsupported = await app.inject({ method, url: "/mcp" });
    assert.equal(unsupported.statusCode, 405);
    assert.equal(unsupported.headers.allow, "POST");
  }
});

test("HTTP MCP enforces hub authentication and Origin restrictions", async (t) => {
  const app = await fixture(t, { token: "remote-secret", allowedOrigins: ["https://client.example.com"] });
  const request = { method: "POST", url: "/mcp", payload: initialize };
  assert.equal((await app.inject({ ...request, headers })).statusCode, 401);
  const authenticated = { ...headers, authorization: "Bearer remote-secret" };
  assert.equal((await app.inject({ ...request, headers: authenticated })).statusCode, 200);
  assert.equal((await app.inject({
    ...request, headers: { ...authenticated, origin: "https://client.example.com" },
  })).statusCode, 200);
  assert.equal((await app.inject({
    ...request, headers: { ...authenticated, origin: "https://evil.example.com" },
  })).statusCode, 403);
  const secureDefault = await fixture(t);
  assert.equal((await secureDefault.inject({
    ...request, headers: { ...headers, origin: "https://evil.example.com" },
  })).statusCode, 403);
});

test("HTTP MCP returns protocol responses for malformed JSON, Accept errors, and tool failures", async (t) => {
  const app = await fixture(t);
  const invalidJson = await app.inject({ method: "POST", url: "/mcp", headers, payload: "{" });
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.json().error.code, -32700);
  const invalidAccept = await app.inject({
    method: "POST", url: "/mcp", headers: { "content-type": "application/json" }, payload: initialize,
  });
  assert.equal(invalidAccept.statusCode, 406);
  const missing = await app.inject({
    method: "POST", url: "/mcp", headers,
    payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_target", arguments: { id: "missing" } } },
  });
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json().result.isError, true);
  const notification = await app.inject({
    method: "POST", url: "/mcp", headers,
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.equal(notification.statusCode, 202);
});

test("independent HTTP MCP clients query the same current registry", async (t) => {
  const app = await fixture(t, { token: "shared-secret" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const auth = { authorization: "Bearer shared-secret" };
  await register(app, definition("docs"), auth);
  const clients = [];
  for (const name of ["first", "second"]) {
    const client = new Client({ name, version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", hub), {
      requestInit: { headers: auth },
    });
    t.after(async () => {
      await client.close();
    });
    await client.connect(transport);
    assert.equal(transport.sessionId, undefined);
    clients.push(client);
  }
  assert.deepEqual((await clients[0].listTools()).tools.map((tool) => tool.name).sort(), [
    "get_target", "get_targets", "search_targets",
  ]);
  const first = await clients[0].callTool({ name: "search_targets", arguments: { q: "문서" } });
  assert.equal(payload(first).total, 1);
  await app.inject({
    method: "PUT", url: "/api/targets/docs", headers: auth,
    payload: definition("docs", { name: "Remote updated" }),
  });
  const second = await clients[1].callTool({ name: "get_target", arguments: { id: "docs" } });
  assert.equal(payload(second).name, "Remote updated");
  await app.inject({ method: "DELETE", url: "/api/targets/docs", headers: auth });
  const searches = await Promise.all(clients.map((client) => client.callTool({
    name: "search_targets", arguments: {},
  })));
  assert.ok(searches.every((result) => payload(result).total === 0));
});

test("OpenAPI request and response schemas and internal references can be validated", async (t) => {
  const app = await fixture(t);
  const spec = (await app.inject("/openapi.json")).json();
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(spec.security, []);
  assert.ok(spec.paths["/mcp"].post);
  assert.equal(spec.paths["/api/targets/{id}"].put.operationId, "updateTarget");
  const validator = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  validator.addSchema(spec, "urn:agent-tcdh:openapi");
  const create = validator.compile({ $ref: "urn:agent-tcdh:openapi#/components/schemas/TargetDefinition" });
  const response = validator.compile({ $ref: "urn:agent-tcdh:openapi#/components/schemas/Target" });
  const list = validator.compile({ $ref: "urn:agent-tcdh:openapi#/components/schemas/SearchResult" });
  const getTargets = spec.paths["/api/targets"].get;
  assert.equal(getTargets.parameters.find(({ name }) => name === "view").schema.const, "summary");
  assert.deepEqual(getTargets.parameters.find(({ name }) => name === "transport").schema.enum, ["stdio", "streamable-http", "sse", "http"]);
  assert.deepEqual(getTargets.parameters.find(({ name }) => name === "auth").schema.enum, ["none", "bearer", "api-key", "oauth2"]);
  assert.equal(getTargets.parameters.find(({ name }) => name === "suggest").schema.type, "boolean");
  const { oneOf } = getTargets.responses[200].content["application/json"].schema;
  const searchResponse = validator.compile({ oneOf: oneOf.map(({ $ref }) => ({ $ref: "urn:agent-tcdh:openapi" + $ref })) });
  const input = definition("schema", {
    capabilities: [{ name: "nested", inputSchema: { type: "object", nested: { values: [1, null, true, { deeper: "value" }] } } }],
  });
  assert.ok(create(input), JSON.stringify(create.errors));
  assert.equal(create({ ...input, unknown: true }), false);
  const saved = (await register(app, input)).json();
  assert.ok(response(saved), JSON.stringify(response.errors));
  assert.equal(response({ ...saved, connection: { transport: "stdio", url: "https://invalid.example" } }), false);
  const results = (await app.inject("/api/targets")).json();
  assert.ok(list(results), JSON.stringify(list.errors));
  assert.ok(searchResponse(results), JSON.stringify(searchResponse.errors));
  const summary = (await app.inject("/api/targets?view=summary&q=nested&transport=streamable-http&auth=none")).json();
  assert.ok(searchResponse(summary), JSON.stringify(searchResponse.errors));
  assert.equal(summary.items[0].transport, "streamable-http");
  assert.equal(summary.items[0].authType, "none");
  assert.equal(list(summary), false);
  const suggested = (await app.inject("/api/targets?q=documentation%20nested%20archived&suggest=true")).json();
  assert.ok(searchResponse(suggested), JSON.stringify(searchResponse.errors));
  assert.equal(suggested.suggestions[0].missingTerm, "archived");
  assert.equal(searchResponse({ ...summary, items: [{ ...summary.items[0], connection: saved.connection }] }), false);
  assert.equal(spec.paths["/api/targets/lookup"].post["x-required-role"], "read");
  const lookupRequest = validator.compile({ $ref: "urn:agent-tcdh:openapi#/components/schemas/TargetLookup" });
  const lookupResult = validator.compile({ $ref: "urn:agent-tcdh:openapi#/components/schemas/TargetLookupResult" });
  const query = { ids: ["missing", "schema"] };
  assert.equal(lookupRequest(query), true);
  assert.equal(lookupRequest({ ids: ["schema", "schema"] }), false);
  const lookup = (await app.inject({ method: "POST", url: "/api/targets/lookup", payload: query })).json();
  assert.ok(lookupResult(lookup), JSON.stringify(lookupResult.errors));
});

test("OpenAPI reflects actual authentication configuration and public health endpoints", async (t) => {
  const app = await fixture(t, { token: "spec-secret" });
  assert.equal((await app.inject("/openapi.json")).statusCode, 401);
  const spec = (await app.inject({
    url: "/openapi.json", headers: { authorization: "Bearer spec-secret" },
  })).json();
  assert.deepEqual(spec.security, [{ hubBearer: [] }]);
  assert.deepEqual(spec.paths["/health"].get.security, []);
  assert.equal(spec.components.securitySchemes.hubBearer.scheme, "bearer");
});

test("Origin configuration rejects wildcards, paths, and non-HTTP URLs", () => {
  const base = { dbPath: ":memory:", allowedOrigins: ["https://client.example.com"] };
  assert.deepEqual(serverOptionsSchema.parse(base).allowedOrigins, base.allowedOrigins);
  for (const origin of ["*", "null", "https://client.example.com/path", "file:///tmp"]) {
    assert.equal(serverOptionsSchema.safeParse({ ...base, allowedOrigins: [origin] }).success, false);
  }
});
