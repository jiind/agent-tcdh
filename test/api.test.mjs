// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { TargetStore } from "../dist/targets/store.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

test("remote MCP capabilities, input schemas, and connection details survive registration", async (t) => {
  const app = await fixture(t);
  const target = definition("docs", {
    capabilities: [{
      name: "search",
      description: "문서 검색",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }],
  });
  const response = await register(app, target);
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers.location, "/api/targets/docs");
  const saved = response.json();
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.capabilities, target.capabilities);
  assert.deepEqual(saved.connection, target.connection);
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)));
  assert.deepEqual((await app.inject("/api/targets/docs")).json(), saved);
});

test("local MCP commands are stored as connection metadata without execution", async (t) => {
  const app = await fixture(t);
  const connection = {
    transport: "stdio",
    command: "/does-not-exist/never-run",
    args: ["--example", "literal; $(never-execute)"],
    envVars: ["EXAMPLE_TOKEN"],
  };
  const response = await register(app, definition("local", { connection }));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().connection, connection);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
});

test("A2A registrations preserve card URLs and authentication requirements", async (t) => {
  const app = await fixture(t);
  const connection = {
    transport: "http", url: "https://agent.example.com",
    agentCardUrl: "https://agent.example.com/.well-known/agent-card.json",
    auth: { type: "bearer", envVars: ["AGENT_TOKEN"] },
  };
  const response = await register(app, definition("research", { protocol: "a2a", connection }));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().connection, connection);
});

test("duplicate target ids preserve existing data and total counts", async (t) => {
  const app = await fixture(t);
  const responses = await Promise.all([
    register(app, definition()),
    register(app, definition("docs", { name: "Duplicate" })),
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
});

test("updates preserve creation timestamps and replace searchable metadata", async (t) => {
  const app = await fixture(t);
  const original = (await register(app, definition())).json();
  const replacement = definition("docs", { name: "Updated", description: "새로운 기능" });
  const response = await app.inject({ method: "PUT", url: "/api/targets/docs", payload: replacement });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().createdAt, original.createdAt);
  assert.equal((await app.inject("/api/targets?q=Updated")).json().total, 1);
  assert.equal((await app.inject("/api/targets?q=Documentation")).json().total, 0);
  const mismatch = await app.inject({
    method: "PUT", url: "/api/targets/docs", payload: definition("other"),
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal((await app.inject("/api/targets/docs")).json().name, "Updated");
});

test("deletion immediately affects discovery and missing targets return 404", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  assert.equal((await app.inject({ method: "DELETE", url: "/api/targets/docs" })).statusCode, 204);
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  assert.equal((await app.inject("/api/targets/docs")).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/targets/docs" })).statusCode, 404);
  assert.equal((await app.inject({
    method: "PUT", url: "/api/targets/docs", payload: definition(),
  })).statusCode, 404);
});

test("read-token batch lookup keeps request order and includes disabled and missing IDs", async (t) => {
  const app = await fixture(t, { token: "lookup-admin", readToken: "lookup-reader" });
  const admin = { authorization: "Bearer lookup-admin" };
  const reader = { authorization: "Bearer lookup-reader" };
  const docs = (await register(app, definition("docs"), admin)).json();
  const disabled = (await register(app, definition("lookup", { enabled: false }), admin)).json();
  const url = "/api/targets/lookup";
  const payload = { ids: ["lookup", "missing", "docs"] };
  assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
  const result = await app.inject({ method: "POST", url, payload, headers: reader });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(result.json(), { items: [{ id: "lookup", target: disabled }, { id: "missing", target: null }, { id: "docs", target: docs }] });
  assert.deepEqual((await app.inject({ url, headers: reader })).json(), disabled);
  assert.equal((await app.inject({ method: "DELETE", url, headers: admin })).statusCode, 204);
  assert.deepEqual((await app.inject({ method: "POST", url, payload: { ids: ["lookup"] }, headers: reader })).json(),
    { items: [{ id: "lookup", target: null }] });
});

test("batch lookup validates the selection and bounds combined stored definition bytes", async (t) => {
  const app = await fixture(t);
  const url = "/api/targets/lookup";
  for (const payload of [{}, { ids: [] }, { ids: ["docs", "docs"] }, { ids: ["../docs"] },
    { ids: Array.from({ length: 11 }, (_, index) => `target-${index}`) }, { ids: ["docs"], includeDisabled: true }]) {
    const invalid = await app.inject({ method: "POST", url, payload });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_INPUT");
  }
  const ids = Array.from({ length: 10 }, (_, index) => `target-${index}`);
  const maximum = await app.inject({ method: "POST", url, payload: { ids } });
  assert.deepEqual(maximum.json().items, ids.map((id) => ({ id, target: null })));

  const targets = ["large-one", "large-two"].map((id) => definition(id, {
    capabilities: [{ name: "large", inputSchema: { type: "object", description: "가".repeat(750_000) } }],
  }));
  const imported = await app.inject({ method: "POST", url: "/api/registry/import", payload: {
    format: "agent-tcdh", version: 1, exportedAt: new Date().toISOString(), targets,
  } });
  assert.equal(imported.statusCode, 200);
  const tooLarge = await app.inject({ method: "POST", url, payload: { ids: targets.map(({ id }) => id) } });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json().error.code, "TARGET_LOOKUP_TOO_LARGE");
  assert.equal(Object.hasOwn(tooLarge.json(), "items"), false);
  const smaller = await app.inject({ method: "POST", url, payload: { ids: ["large-two"] } });
  assert.equal(smaller.statusCode, 200);
  assert.equal(smaller.json().items[0].target.id, "large-two");
});

test("all keywords may match across different fields and results are ranked", async (t) => {
  const app = await fixture(t);
  await register(app, definition("a", { name: "Guide", description: "배포 문서" }));
  await register(app, definition("b", { name: "배포", description: "문서" }));
  await register(app, definition("c", { name: "배포", description: "관련 없는 내용", tags: [], capabilities: [] }));
  const results = (await app.inject("/api/targets?q=" + encodeURIComponent("배포 문서"))).json();
  assert.equal(results.total, 2);
  assert.deepEqual(results.items.map((item) => item.id), ["b", "a"]);
  assert.equal((await app.inject("/api/targets?q=" + encodeURIComponent("' OR 1=1 --"))).json().total, 0);
});

test("exact identifiers, names, and capabilities outrank repeated partial matches", async (t) => {
  const app = await fixture(t);
  const q = "invoice-export";
  for (const target of [
    definition("invoice-export", { name: "Invoices" }),
    definition("b", { name: "Invoice-Export" }),
    definition("c", { capabilities: [{ name: q, description: "Export invoices" }] }),
    definition("a-archive-invoice-export", { name: "Old invoice-export archive", tags: [q], description: q,
      capabilities: [{ name: "read_invoice-export", description: q }] }),
  ]) {
    assert.equal((await register(app, target)).statusCode, 201);
  }
  const page = (await app.inject("/api/targets?q=invoice-export&limit=2&offset=1")).json();
  assert.equal(page.total, 4);
  assert.deepEqual(page.items.map((item) => item.id), ["b", "c"]);
  assert.equal((await app.inject("/api/targets?q=invoice-export&limit=1")).json().items[0].id, q);
});

test("a capability covering all terms outranks split matches after exact matches", async (t) => {
  const app = await fixture(t);
  const q = "warehouse stock reserve";
  for (const target of [
    definition("exact", { name: "Warehouse stock reserve", capabilities: [] }),
    definition("focused", { name: "Hold inventory", capabilities: [{ name: "reserve_stock", description: "Hold items at the selected warehouse." }] }),
    definition("directory", { name: "Warehouse stock reserve services", tags: ["warehouse", "stock", "reserve"], capabilities: [
      { name: "warehouse_stock", description: "List inventory" }, { name: "reserve", description: "Read reserve settings" },
    ] }),
    definition("partial", { name: "Hold records", capabilities: [{ name: "reserve_stock", description: "Hold items" }] }),
  ]) {
    assert.equal((await register(app, target)).statusCode, 201);
  }

  for (const query of [new URLSearchParams({ q }), new URLSearchParams({ q: "warehouse_stock_reserve", match: "normalized" })]) {
    const path = "/api/targets?" + query;
    const full = (await app.inject(path)).json();
    assert.equal(full.total, 3);
    assert.deepEqual(full.items.map(({ id }) => id), ["exact", "focused", "directory"]);
    const summary = (await app.inject(path + "&view=summary&offset=1")).json();
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.items.map(({ id }) => id), ["focused", "directory"]);
    assert.equal(summary.items[0].matchedCapabilities[0].name, "reserve_stock");
  }
});

test("opt-in search normalization composes Unicode and treats hyphens and underscores as separators", async (t) => {
  const app = await fixture(t);
  for (const target of [
    definition("coffee-guide", { name: "Café 가이드", tags: ["Guide"] }),
    definition("coffee_guide", { name: "Café_가이드", tags: ["Guide"], enabled: false }),
    definition("unrelated", { name: "Café Reference", tags: ["Guide"], description: "Reference material" }),
  ]) {
    assert.equal((await register(app, target)).statusCode, 201);
  }
  const query = "/api/targets?q=" + encodeURIComponent("CAFE\u0301_가이드") + "&tag=guide";
  assert.equal((await app.inject(query)).json().total, 0);
  assert.deepEqual((await app.inject(query + "&match=normalized")).json().items.map((item) => item.id), ["coffee-guide"]);
  const ids = (await app.inject("/api/targets?q=coffee_guide&match=normalized&includeDisabled=true")).json().items.map((item) => item.id);
  assert.deepEqual(ids, ["coffee_guide", "coffee-guide"]);
  assert.equal((await app.inject("/api/targets?q=_--_&match=normalized")).json().total, 0);
});

test("search summaries preserve ranked pages and omit connection and input-schema metadata", async (t) => {
  const app = await fixture(t);
  const target = definition("invoice-tool", {
    description: "x".repeat(238) + "😀 details",
    tags: ["billing"],
    connection: { transport: "stdio", command: "fixture-command", args: ["fixture-argument"], envVars: ["FIXTURE_TOKEN"] },
    capabilities: [
      { name: "read", description: "Invoice export guide" },
      { name: "invoice", description: "Get a record" },
      { name: "invoice_export", description: "x".repeat(158) + "😀 details", inputSchema: { type: "object", title: "Fixture schema" } },
      { name: "download", description: "Download invoice export data" },
      { name: "health", description: "Read status" },
    ],
  });
  assert.equal((await register(app, target)).statusCode, 201);
  assert.equal((await register(app, definition("z-disabled", { ...target, id: "z-disabled", enabled: false }))).statusCode, 201);

  const path = "/api/targets?q=invoice-export&match=normalized&protocol=mcp&tag=billing&limit=1&includeDisabled=true";
  const full = (await app.inject(path)).json();
  const summarized = await app.inject(path + "&view=summary");
  assert.equal(summarized.statusCode, 200);
  const { items, ...page } = summarized.json();
  assert.deepEqual(page, { view: "summary", total: 2, limit: 1, offset: 0 });
  assert.equal(items[0].id, full.items[0].id);
  assert.equal(items[0].capabilityCount, 5);
  assert.equal(items[0].description, "x".repeat(238) + "…");
  assert.deepEqual(items[0].matchedCapabilities, [
    { name: "invoice_export", description: "x".repeat(158) + "…" },
    { name: "read", description: "Invoice export guide" },
    { name: "download", description: "Download invoice export data" },
  ]);
  assert.doesNotMatch(summarized.body, /connection|inputSchema|fixture-command|fixture-argument|FIXTURE_TOKEN|Fixture schema/);
  assert.deepEqual((await app.inject("/api/targets/invoice-tool")).json(), full.items[0]);
  const secondPage = (await app.inject(path + "&view=summary&offset=1")).json();
  assert.equal(secondPage.items[0].enabled, false);
  assert.equal(secondPage.items[0].id, (await app.inject(path + "&offset=1")).json().items[0].id);
  assert.deepEqual((await app.inject("/api/targets?view=summary&offset=2")).json(), { view: "summary", items: [], total: 1, limit: 20, offset: 2 });
  assert.deepEqual((await app.inject("/api/targets?view=summary")).json().items[0].matchedCapabilities, []);
});

test("suggestions explain one missing term while keeping complete matches and filters authoritative", async (t) => {
  const app = await fixture(t);
  const focused = definition("focused", { name: "Log inspection", capabilities: [
    { name: "audit-log", description: "Find records in a region." },
  ] });
  const directories = [1, 2, 3, 4].map((index) => definition(`directory-${index}`, {
    name: "Region audit log directory", tags: ["docs", "region", "audit", "log"], capabilities: [],
  }));
  const targets = [
    focused, ...directories,
    definition("retired", { name: "Region audit log archive", enabled: false }),
    definition("other-protocol", { name: "Region audit log archive", protocol: "a2a",
      connection: { transport: "http", url: "https://fixture.example/agent" } }),
    definition("other-auth", { name: "Region audit log archive", connection: { transport: "streamable-http",
      url: "https://fixture.example/mcp", auth: { type: "bearer", envVars: ["FIXTURE_TOKEN"] } } }),
    definition("other-tag", { name: "Region audit log archive", tags: ["other"] }),
  ];
  for (const target of targets) {
    assert.equal((await register(app, target)).statusCode, 201);
  }

  const filters = "&match=normalized&protocol=mcp&transport=streamable-http&auth=none&tag=docs";
  const path = "/api/targets?q=" + encodeURIComponent("Region audit-log Archive") + filters;
  const empty = { items: [], total: 0, limit: 20, offset: 0 };
  assert.deepEqual((await app.inject(path)).json(), empty);
  assert.deepEqual((await app.inject(path + "&suggest=false")).json(), empty);
  const { suggestions, ...result } = (await app.inject(path + "&suggest=true")).json();
  assert.deepEqual(result, empty);
  assert.deepEqual(suggestions.map(({ id, missingTerm }) => [id, missingTerm]),
    [["focused", "archive"], ["directory-1", "archive"], ["directory-2", "archive"]]);
  assert.equal(suggestions[0].matchedCapabilities[0].name, "audit-log");
  assert.equal(Object.hasOwn(suggestions[0], "connection"), false);
  const summary = (await app.inject(path + "&suggest=true&view=summary&limit=1")).json();
  assert.equal(summary.view, "summary");
  assert.deepEqual(summary.suggestions, suggestions.slice(0, 1));

  const complete = (await app.inject(path + "&suggest=true&includeDisabled=true")).json();
  assert.deepEqual(complete.items.map(({ id }) => id), ["retired"]);
  assert.deepEqual(complete.suggestions, []);
  for (const url of [path + "&offset=1", "/api/targets?q=region%20absent" + filters,
    "/api/targets?q=region%20absent%20postcard%20finances" + filters]) {
    const none = (await app.inject(url + "&suggest=true")).json();
    assert.equal(none.total, 0);
    assert.deepEqual(none.suggestions, []);
  }
});

test("protocol and tag filters are applied before pagination and total counts", async (t) => {
  const app = await fixture(t);
  await register(app, definition("a"));
  await register(app, definition("b", { tags: ["Docs"] }));
  await register(app, definition("c", { tags: ["other"] }));
  await register(app, definition("d", {
    protocol: "a2a", connection: { transport: "http", url: "https://agent.example.com" },
  }));
  const results = (await app.inject("/api/targets?protocol=mcp&tag=docs&limit=1&offset=1")).json();
  assert.equal(results.total, 2);
  assert.equal(results.limit, 1);
  assert.equal(results.offset, 1);
  assert.deepEqual(results.items.map((item) => item.id), ["b"]);
  assert.equal((await app.inject("/api/targets?offset=99")).json().items.length, 0);
});

test("unranked pages use ID order and preserve filtered totals beyond the last page", async (t) => {
  const app = await fixture(t);
  for (const target of [
    definition("docs_z"),
    definition("docs.a", { enabled: false }),
    definition("docs-b"),
    definition("peer", { protocol: "a2a", connection: { transport: "http", url: "https://fixture.example/agent" } }),
  ]) {
    assert.equal((await register(app, target)).statusCode, 201);
  }
  const page = (await app.inject("/api/targets?protocol=mcp&includeDisabled=true&limit=2&offset=1&view=summary")).json();
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map(({ id }) => id), ["docs.a", "docs_z"]);
  assert.deepEqual((await app.inject("/api/targets?protocol=mcp&limit=1&offset=2")).json(), { items: [], total: 2, limit: 1, offset: 2 });
  assert.deepEqual((await app.inject("/api/targets?protocol=a2a")).json().items.map(({ id }) => id), ["peer"]);
});

test("ranked pages read complete definitions from the same snapshot used to select their IDs", async (t) => {
  const dbPath = join(await temporaryDirectory(t), "discovery.sqlite");
  const app = await fixture(t, { dbPath });
  const original = definition("docs", { name: "Regional usage report", capabilities: [
    { name: "inspect", description: "Read records", inputSchema: { type: "object", properties: { period: { type: "string" } } } },
  ] });
  const saved = (await register(app, original)).json();
  const writer = new TargetStore(dbPath);
  t.after(() => writer.close());
  const prepare = DatabaseSync.prototype.prepare;
  let updated = false;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    if (!updated && sql.includes("FROM targets WHERE id IN (")) {
      updated = true;
      writer.update("docs", { ...original, enabled: true, name: "Account preferences" });
    }
    return prepare.call(this, sql);
  });

  const q = "/api/targets?q=" + encodeURIComponent("Regional usage report");
  const page = await app.inject(q);
  assert.equal(page.statusCode, 200);
  assert.equal(updated, true);
  assert.deepEqual(page.json(), { items: [saved], total: 1, limit: 20, offset: 0 });
  assert.equal((await app.inject("/api/targets/docs")).json().name, "Account preferences");
  assert.deepEqual((await app.inject(q)).json(), { items: [], total: 0, limit: 20, offset: 0 });
});

test("discovery filters registered transports and remote authentication before pagination", async (t) => {
  const app = await fixture(t);
  const targets = [
    definition("local", { connection: { transport: "stdio", command: "fixture-local", envVars: ["LOCAL_PROFILE"] } }),
    definition("remote-implicit"),
    definition("remote-explicit", { connection: { transport: "sse", url: "https://fixture.example/sse", auth: { type: "none" } } }),
    definition("remote-bearer", { connection: { transport: "streamable-http", url: "https://fixture.example/mcp",
      auth: { type: "bearer", envVars: ["FIXTURE_BEARER"] } } }),
    definition("remote-disabled", { enabled: false, connection: { transport: "streamable-http", url: "https://fixture.example/mcp",
      auth: { type: "bearer", envVars: ["FIXTURE_BEARER"] } } }),
    ...["api-key", "oauth2"].map((type) => definition("peer-" + type, { protocol: "a2a", connection: {
      transport: "http", url: "https://fixture.example/agent", auth: { type },
    } })),
  ];
  for (const target of targets) {
    assert.equal((await register(app, target)).statusCode, 201);
  }

  const query = "/api/targets?q=documentation&protocol=mcp&transport=streamable-http&auth=bearer&tag=Docs";
  const full = (await app.inject(query)).json();
  assert.deepEqual(full.items.map(({ id }) => id), ["remote-bearer"]);
  const summary = await app.inject(query + "&includeDisabled=true&limit=1&offset=1&view=summary");
  assert.equal(summary.statusCode, 200);
  const { items, ...page } = summary.json();
  assert.deepEqual(page, { view: "summary", total: 2, limit: 1, offset: 1 });
  assert.deepEqual(items.map(({ id, transport, authType, enabled }) => ({ id, transport, authType, enabled })),
    [{ id: "remote-disabled", transport: "streamable-http", authType: "bearer", enabled: false }]);
  assert.doesNotMatch(summary.body, /fixture\.example|FIXTURE_BEARER|envVars/);

  const noAuth = (await app.inject("/api/targets?auth=none&view=summary")).json();
  assert.deepEqual(noAuth.items.map(({ id, transport, authType }) => [id, transport, authType]),
    [["remote-explicit", "sse", "none"], ["remote-implicit", "streamable-http", "none"]]);
  const local = (await app.inject("/api/targets?transport=stdio&view=summary")).json().items[0];
  assert.equal(local.transport, "stdio");
  assert.equal(Object.hasOwn(local, "authType"), false);
  assert.equal((await app.inject("/api/targets?transport=stdio&auth=none")).json().total, 0);
  assert.equal((await app.inject("/api/targets?protocol=mcp&transport=http")).json().total, 0);
  for (const auth of ["api-key", "oauth2"]) {
    const page = (await app.inject("/api/targets?transport=http&auth=" + auth)).json();
    assert.deepEqual(page.items.map(({ id }) => id), ["peer-" + auth]);
  }

  assert.equal((await app.inject({ method: "PUT", url: "/api/targets/remote-bearer",
    payload: definition("remote-bearer") })).statusCode, 200);
  assert.equal((await app.inject(query)).json().total, 0);
});

test("disabled targets can be re-enabled and false strings are not treated as true", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  const disabled = definition("docs", { enabled: false });
  await app.inject({ method: "PUT", url: "/api/targets/docs", payload: disabled });
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  assert.equal((await app.inject("/api/targets?includeDisabled=false")).json().total, 0);
  assert.equal((await app.inject("/api/targets?includeDisabled=true")).json().total, 1);
  assert.equal((await app.inject("/api/targets/docs")).json().enabled, false);
  await app.inject({ method: "PUT", url: "/api/targets/docs", payload: definition() });
  assert.equal((await app.inject("/api/targets")).json().total, 1);
});

test("unsupported search options and invalid pagination are rejected", async (t) => {
  const app = await fixture(t);
  for (const query of [
    "limit=0", "limit=101", "limit=abc", "offset=-1", "offset=1.2",
    "protocol=unknown", "match=unknown", "view=unknown", "transport=unknown", "auth=basic", "includeDisabled=yes", "suggest=yes", "unknown=value", "q=a&q=b",
  ]) {
    const response = await app.inject("/api/targets?" + query);
    assert.equal(response.statusCode, 400, query);
  }
});

test("protocol, connection, and metadata boundaries are validated", async (t) => {
  const app = await fixture(t);
  const invalid = [
    definition("../escape"),
    definition("space", { name: "   " }),
    definition("proto", { protocol: "a2a", connection: { transport: "stdio", command: "node" } }),
    definition("url", { connection: { transport: "streamable-http", url: "file:///etc/passwd" } }),
    definition("credentials", { connection: { transport: "sse", url: "https://user:secret@example.com" } }),
    definition("fragment", { connection: { transport: "sse", url: "https://example.com/#fragment" } }),
    definition("env", { connection: { transport: "stdio", command: "node", env: { TOKEN: "secret" } } }),
    definition("auth", { connection: { transport: "sse", url: "https://example.com", auth: { type: "bearer", token: "secret" } } }),
    definition("duplicate", { capabilities: [{ name: "same" }, { name: "same" }] }),
    { ...definition("unknown"), unexpected: true },
  ];
  for (const target of invalid) {
    const response = await register(app, target);
    assert.equal(response.statusCode, 400, target.id);
    assert.equal(response.json().error.code, "INVALID_INPUT");
  }
  assert.equal((await app.inject("/api/targets")).json().total, 0);
});

test("hub tokens protect reads and writes while health remains public", async (t) => {
  const app = await fixture(t, { token: "test-secret" });
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/api/targets")).statusCode, 401);
  assert.equal((await register(app, definition())).statusCode, 401);
  assert.equal((await app.inject({
    url: "/api/targets", headers: { authorization: "Bearer wrong" },
  })).statusCode, 401);
  const headers = { authorization: "Bearer test-secret" };
  assert.equal((await register(app, definition(), headers)).statusCode, 201);
  assert.equal((await app.inject({ url: "/api/targets", headers })).json().total, 1);
});

test("body size limits and invalid JSON use consistent error responses", async (t) => {
  const app = await fixture(t);
  const invalid = await app.inject({
    method: "POST", url: "/api/targets",
    headers: { "content-type": "application/json" }, payload: "{",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_REQUEST");
  const large = await app.inject({
    method: "POST", url: "/api/targets",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ data: "x".repeat(1_048_576) }),
  });
  assert.equal(large.statusCode, 413);
});

test("SQLite preserves updates, deletions, and connection details across restart", async (t) => {
  const directory = await temporaryDirectory(t);
  const dbPath = join(directory, "nested", "registry.sqlite");
  const first = createApp({ logger: false, dbPath });
  await register(first, definition("keep"));
  await register(first, definition("remove"));
  await first.inject({
    method: "PUT", url: "/api/targets/keep", payload: definition("keep", { enabled: false }),
  });
  await first.inject({ method: "DELETE", url: "/api/targets/remove" });
  await first.close();
  const second = await fixture(t, { dbPath });
  assert.equal((await second.inject("/api/targets")).json().total, 0);
  const saved = (await second.inject("/api/targets?includeDisabled=true")).json();
  assert.equal(saved.total, 1);
  assert.equal(saved.items[0].id, "keep");
  assert.equal(saved.items[0].connection.url, "http://127.0.0.1:1/mcp");
});

test("unsupported database versions are not overwritten", async (t) => {
  const directory = await temporaryDirectory(t);
  const dbPath = join(directory, "future.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA user_version = 99");
  database.close();
  assert.throws(() => createApp({ logger: false, dbPath }), /version/);
  const reopened = new DatabaseSync(dbPath);
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 99);
  reopened.close();
});
