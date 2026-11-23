// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { AgentCard, Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createA2aDiscoveryHandler, createHubAgentCard } from "../dist/a2a-discovery.js";
import { inspectRemote, remoteImportSchema } from "../dist/remote-import.js";
import { serverOptionsSchema } from "../dist/server.js";
import { definition, fixture, register } from "./helpers.mjs";

/** Build a message request for the selected protocol version. */
function messageRequest(data, version = "1.0", extra = {}) {
  const legacy = version !== "1.0";
  return { jsonrpc: "2.0", id: randomUUID(), method: legacy ? "message/send" : "SendMessage", params: {
    message: { ...(legacy ? { kind: "message" } : {}), role: legacy ? "user" : "ROLE_USER", messageId: randomUUID(),
      parts: [typeof data === "string" ? { ...(legacy ? { kind: "text" } : {}), text: data }
        : { ...(legacy ? { kind: "data" } : {}), data }], ...extra },
  } };
}

/** Inject an A2A request and read its structured message result. */
async function send(app, data, version = "1.0", headers = {}) {
  return app.inject({ method: "POST", url: "/a2a", headers: { "a2a-version": version, ...headers },
    payload: messageRequest(data, version) });
}

/** Extract a discovery result from a version-specific response message. */
function result(response, version = "1.0") {
  const body = response.json();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.error, undefined, response.body);
  const message = version === "1.0" ? body.result.message : body.result;
  return message.parts[0].data ?? JSON.parse(message.parts[0].text);
}

test("public cards describe versioned discovery and authentication without listing targets or secrets", async (t) => {
  const app = await fixture(t, { token: "admin-secret", readToken: "read-secret", publicUrl: " https://hub.example.com/tcdh/ " });
  await register(app, definition("private-entry"), { authorization: "Bearer admin-secret" });
  for (const version of ["1.0", "0.3", "0.3.0"]) {
    const response = await app.inject({ url: "/.well-known/agent-card.json", headers: { "a2a-version": version,
      host: "attacker.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["a2a-version"], version);
    assert.equal(response.headers.vary, "A2A-Version");
    assert.equal(response.headers["cache-control"], "no-store");
    const card = response.json();
    assert.deepEqual(card.skills.map((skill) => skill.id), ["search_targets", "get_target", "get_targets"]);
    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
    if (version === "1.0") {
      assert.equal(card.supportedInterfaces[0].url, "https://hub.example.com/tcdh/a2a");
      assert.deepEqual(card.securityRequirements, [{ schemes: { hubBearer: {} } }]);
      assert.equal(card.securitySchemes.hubBearer.httpAuthSecurityScheme.scheme, "bearer");
      assert.ok(AgentCard.fromJSON(card).securityRequirements.length);
      assert.deepEqual(AgentCard.fromJSON(card).securityRequirements[0].schemes.hubBearer.list, []);
    } else {
      assert.equal(card.url, "https://hub.example.com/tcdh/a2a");
      assert.equal(card.preferredTransport, "JSONRPC");
      assert.deepEqual(card.security, [{ hubBearer: [] }]);
    }
    for (const secret of ["admin-secret", "read-secret", "private-entry", "attacker.example", "evil.example"]) {
      assert.equal(response.body.includes(secret), false);
    }
  }
  const omitted = await app.inject({ url: "/.well-known/agent-card.json" });
  assert.equal(omitted.json().protocolVersion, "0.3.0");
});

test("A2A 1.0 and 0.3 query the same live registry and immediately reflect changes", async (t) => {
  const app = await fixture(t);
  await register(app, definition("docs"));
  await register(app, definition("disabled", { enabled: false }));
  await register(app, definition("reviewer", { protocol: "a2a", tags: ["review"],
    connection: { transport: "http", url: "https://agent.example.com/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" } }));
  for (const version of ["1.0", "0.3", "0.3.0"]) {
    const found = result(await send(app, "문서", version), version);
    assert.deepEqual(found.items.map((item) => item.id), ["docs", "reviewer"]);
    const filtered = result(await send(app, { operation: "search_targets", arguments: { protocol: "a2a", tag: "review", limit: 1 } }, version), version);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].connection.protocolVersion, "1.0");
    const normalized = result(await send(app, { operation: "search_targets",
      arguments: { q: "배포_가이드", match: "normalized", protocol: "a2a" } }, version), version);
    assert.deepEqual(normalized.items.map((item) => item.id), ["reviewer"]);
    const summary = result(await send(app, { operation: "search_targets",
      arguments: { q: "자료", view: "summary", protocol: "a2a" } }, version), version);
    assert.equal(summary.view, "summary");
    assert.deepEqual(summary.items[0].matchedCapabilities, [{ name: "search_docs", description: "공식 자료 조사" }]);
    assert.equal(Object.hasOwn(summary.items[0], "connection"), false);
    assert.equal(result(await send(app, { operation: "search_targets", arguments: { includeDisabled: true, limit: 1, offset: 2 } }, version), version).total, 3);
  }
  await app.inject({ method: "PUT", url: "/api/targets/docs", payload: definition("docs", { name: "Updated" }) });
  assert.equal(result(await send(app, { operation: "get_target", arguments: { id: "docs" } })).name, "Updated");
  await app.inject({ method: "DELETE", url: "/api/targets/docs" });
  assert.equal(result(await send(app, { operation: "get_target", arguments: { id: "docs" } })).error.code, "TARGET_NOT_FOUND");
  assert.equal(result(await send(app, { operation: "search_targets" })).total, 1);
});

test("read tokens allow A2A queries while authentication precedes body parsing and blocks mutations", async (t) => {
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  for (const authorization of [undefined, "Bearer wrong"]) {
    const response = await app.inject({ method: "POST", url: "/a2a", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, payload: "{" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["www-authenticate"], "Bearer");
  }
  const headers = { authorization: "Bearer reader" };
  assert.equal(result(await send(app, "", "1.0", headers)).total, 0);
  const denied = await send(app, { operation: "remove_target", arguments: { id: "docs" } }, "1.0", headers);
  assert.equal(denied.json().error.code, -32602);
  const registerDenied = await register(app, definition(), headers);
  assert.equal(registerDenied.statusCode, 403);
});

test("the official SDK discovers the card and queries both versions over real HTTP", async (t) => {
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  await register(app, definition("sdk"), { authorization: "Bearer admin" });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const calls = [];
  /** Record requested versions and apply read credentials. */
  const authenticatedFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer reader");
    calls.push({ url: String(input), version: headers.get("A2A-Version") });
    return fetch(input, { ...init, headers });
  };
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch, legacyCompat: { enabled: true } })] });
  const native = await factory.createFromUrl(url);
  const response = await native.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "get_target", arguments: { id: "sdk" } } }],
  } }));
  assert.equal(Message.toJSON(response).parts[0].data.id, "sdk");
  const legacyCard = AgentCard.fromJSON({ ...(await native.getAgentCard()), supportedInterfaces: [{
    url: url + "/a2a", protocolBinding: "JSONRPC", protocolVersion: "0.3",
  }] });
  const legacy = await factory.createFromAgentCard(legacyCard);
  const older = await legacy.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "" }],
  } }));
  assert.equal(Message.toJSON(older).parts[0].data.total, 1);
  assert.ok(calls.some((call) => call.version === "1.0"));
  assert.ok(calls.some((call) => call.version === "0.3"));
});

test("text output and context ids are preserved without merging conversation history", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  const request = messageRequest("", "1.0", { contextId: "caller-context" });
  request.params.configuration = { acceptedOutputModes: ["text/plain"] };
  const response = await app.inject({ method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" }, payload: request });
  const message = response.json().result.message;
  assert.equal(message.contextId, "caller-context");
  assert.equal(JSON.parse(message.parts[0].text).total, 1);
  assert.equal(message.parts[0].data, undefined);
  const another = await send(app, "no-match");
  assert.equal(result(another).total, 0);
  assert.notEqual(another.json().result.message.messageId, message.messageId);
});

test("consumers call discovered MCP and A2A targets directly without execution during hub queries", async (t) => {
  const peer = await fixture(t);
  const calls = [];
  peer.server.on("request", (request) => {
    if (["/a2a", "/mcp"].includes(request.url)) {
      calls.push(request.url);
    }
  });
  await register(peer, definition("receipt"));
  const peerUrl = await peer.listen({ host: "127.0.0.1", port: 0 });
  const hub = await fixture(t);
  await register(hub, definition("remote-mcp", { connection: { transport: "streamable-http", url: peerUrl + "/mcp" } }));
  await register(hub, definition("remote-agent", { protocol: "a2a", connection: {
    transport: "http", url: peerUrl + "/a2a", agentCardUrl: peerUrl + "/.well-known/agent-card.json",
    protocolBinding: "JSONRPC", protocolVersion: "1.0",
  } }));
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  const consumer = await factory.createFromUrl(hubUrl);
  const discovered = await consumer.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "" }],
  } }));
  const entries = Message.toJSON(discovered).parts[0].data.items;
  assert.equal(entries.length, 2);
  assert.deepEqual(calls, []);

  const agentTarget = entries.find((item) => item.protocol === "a2a");
  const agent = await factory.createFromUrl(new URL(agentTarget.connection.agentCardUrl).origin);
  const response = await agent.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "get_target", arguments: { id: "receipt" } } }],
  } }));
  assert.equal(Message.toJSON(response).parts[0].data.id, "receipt");
  assert.deepEqual(calls, ["/a2a"]);

  const mcpTarget = entries.find((item) => item.protocol === "mcp");
  const client = new McpClient({ name: "direct-consumer", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpTarget.connection.url)));
  const tool = await client.callTool({ name: "get_target", arguments: { id: "receipt" } });
  assert.equal(JSON.parse(tool.content[0].text).id, "receipt");
  assert.ok(calls.includes("/mcp"));
});

test("invalid parts, commands, filters, and output modes are rejected before SDK coercion", async (t) => {
  const app = await fixture(t);
  const invalidData = [null, [], { operation: "get_target", arguments: { id: "../x" } },
    { operation: "search_targets", arguments: { includeDisabled: "false" } },
    { operation: "search_targets", arguments: { view: "unknown" } },
    { operation: "search_targets", arguments: { limit: 101 } },
    { operation: "search_targets", arguments: { q: "x".repeat(501) } },
    { operation: "search_targets", arguments: {}, execute: true }];
  for (const data of invalidData) {
    assert.equal((await send(app, data)).json().error.code, -32602);
  }
  for (const version of ["1.0", "0.3"]) {
    for (const part of [{ text: "x", data: {} }, { text: 10 }, { raw: "eA==" }, { url: "https://agent.example.com" },
      { text: "x", mediaType: "text/html" }, { kind: "file", file: { uri: "https://agent.example.com" } }]) {
      const body = messageRequest("", version);
      body.params.message.parts = [{ ...(version !== "1.0" ? { kind: "text" } : {}), ...part }];
      const response = await app.inject({ method: "POST", url: "/a2a", headers: { "a2a-version": version }, payload: body });
      assert.ok([-32602, -32005].includes(response.json().error.code), response.body);
    }
  }
  for (const configuration of [{ acceptedOutputModes: ["image/png"] }, { acceptedOutputModes: "text/plain" }, { pushNotificationConfig: { url: "https://never.example" } }]) {
    const body = messageRequest("");
    body.params.configuration = configuration;
    const response = await app.inject({ method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" }, payload: body });
    assert.ok(response.json().error);
  }
});

test("both versions report unsupported streams, tasks, and push notifications", async (t) => {
  const app = await fixture(t);
  for (const version of ["1.0", "0.3"]) {
    const methods = version === "1.0"
      ? { SendStreamingMessage: -32004, SubscribeToTask: -32004, GetTask: -32001, CancelTask: -32001,
        CreateTaskPushNotificationConfig: -32003, GetExtendedAgentCard: -32007, ExecuteTarget: -32601 }
      : { "message/stream": -32004, "tasks/resubscribe": -32004, "tasks/get": -32001, "tasks/cancel": -32001,
        "tasks/pushNotificationConfig/set": -32003, "agent/getAuthenticatedExtendedCard": -32007, executeTarget: -32601 };
    for (const [method, code] of Object.entries(methods)) {
      const body = { ...messageRequest("", version), method };
      const response = await app.inject({ method: "POST", url: "/a2a", headers: { "a2a-version": version }, payload: body });
      assert.equal(response.json().error.code, code, response.body);
    }
  }
  const body = messageRequest("", "1.0", { taskId: "missing" });
  assert.equal((await app.inject({ method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" }, payload: body })).json().error.code, -32001);
});

test("invalid JSON, batches, notifications, and unsupported versions produce explicit errors", async (t) => {
  const app = await fixture(t);
  const syntax = await app.inject({ method: "POST", url: "/a2a", headers: { "content-type": "application/json" }, payload: "{" });
  assert.equal(syntax.json().error.code, -32700);
  for (const payload of [[], [messageRequest("")], { jsonrpc: "2.0", method: "SendMessage", params: {} }, { jsonrpc: "2.0", id: true, method: "SendMessage" }]) {
    const response = await app.inject({ method: "POST", url: "/a2a", payload });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, -32600);
  }
  for (const url of ["/a2a", "/.well-known/agent-card.json"]) {
    const response = await app.inject({ method: url === "/a2a" ? "POST" : "GET", url, headers: { "a2a-version": "2.0" }, ...(url === "/a2a" ? { payload: messageRequest("") } : {}) });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, -32009);
  }
  const oversized = await send(app, "x".repeat(1_048_576));
  assert.equal(oversized.statusCode, 413);
  const wrongType = await app.inject({ method: "POST", url: "/a2a", headers: { "content-type": "application/octet-stream" }, payload: "x" });
  assert.equal(wrongType.statusCode, 415);
  const wrongMethod = await app.inject({ method: "GET", url: "/a2a" });
  assert.equal(wrongMethod.statusCode, 404);
});

test("allowed origins and listener addresses prevent Host header poisoning", async (t) => {
  const app = await fixture(t, { allowedOrigins: ["https://client.example.com"] });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const card = await app.inject({ url: "/.well-known/agent-card.json", headers: { host: "evil.example" } });
  assert.equal(card.json().url, url + "/a2a");
  for (const path of ["/a2a", "/.well-known/agent-card.json"]) {
    const denied = await app.inject({ url: path, method: path === "/a2a" ? "POST" : "GET", headers: { origin: "https://evil.example" } });
    assert.equal(denied.statusCode, 403);
  }
  const permitted = await send(app, "", "1.0", { origin: "https://client.example.com" });
  assert.equal(result(permitted).total, 0);
});

test("hub cards can be imported as A2A targets and invalid public URLs are rejected", async (t) => {
  const app = await fixture(t);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const version of ["1.0", "0.3.0"]) {
    const target = await inspectRemote(remoteImportSchema.parse({ id: "hub", protocol: "a2a", url,
      a2aBinding: "JSONRPC", a2aVersion: version }));
    assert.equal(target.connection.url, url + "/a2a");
    assert.equal(target.connection.protocolVersion, version);
    assert.equal(target.capabilities.length, 3);
  }
  for (const publicUrl of ["not-a-url", "ftp://hub.example.com", "https://user:secret@hub.example.com", "https://hub.example.com?q=x", "https://hub.example.com#x", "https://hub.example.com/?", "https://hub.example.com/#"]) {
    assert.equal(serverOptionsSchema.safeParse({ publicUrl }).success, false);
  }
});

test("unexpected storage error details are excluded from A2A responses", async () => {
  /** Reproduce an unexpected storage failure. */
  function failRead() {
    throw new Error("private-db-secret");
  }
  const handler = createA2aDiscoveryHandler({ search: failRead, get: failRead, getMany: failRead },
    createHubAgentCard("https://hub.example.com", false), { operation: "search_targets", arguments: {} });
  await assert.rejects(handler.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: "id", role: "ROLE_USER", parts: [{ text: "" }] } })), (error) => {
    assert.equal(error.message.includes("private-db-secret"), false);
    return true;
  });
});

test("OpenAPI describes public cards, read access, and structured A2A query input", async (t) => {
  const app = await fixture(t, { token: "admin" });
  const response = await app.inject({ url: "/openapi.json", headers: { authorization: "Bearer admin" } });
  const doc = response.json();
  assert.deepEqual(doc.paths["/.well-known/agent-card.json"].get.security, []);
  assert.equal(doc.paths["/a2a"].post["x-required-role"], "read");
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(doc.components.schemas.DiscoveryCommand);
  assert.equal(validate({ operation: "get_target", arguments: { id: "docs" } }), true);
  assert.equal(validate({ operation: "get_targets", arguments: { ids: ["docs", "research"] } }), true);
  assert.equal(validate({ operation: "get_targets", arguments: { ids: ["docs", "docs"] } }), false);
  assert.equal(validate({ operation: "search_targets", arguments: { protocol: "mcp", limit: 10 } }), true);
  assert.equal(validate({ operation: "execute", arguments: {} }), false);
});
