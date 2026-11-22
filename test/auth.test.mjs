// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../dist/app.js";
import { readClientToken } from "../dist/auth.js";
import { HubClient } from "../dist/client.js";
import { serverOptionsSchema } from "../dist/server.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

const admin = { authorization: "Bearer auth-admin-secret" };
const read = { authorization: "Bearer auth-reader-secret" };
const options = { token: "auth-admin-secret", readToken: "auth-reader-secret", logger: false };
const execute = promisify(execFile);

/** Run the CLI with a hub token referenced by environment variable name. */
async function cli(args, env = {}) {
  return execute(process.execPath, [resolve("dist/index.js"), ...args], {
    env: {
      ...process.env,
      AGENT_TCDH_TOKEN: "wrong-default",
      ADMIN_CREDENTIAL: "auth-admin-secret",
      READER_CREDENTIAL: "auth-reader-secret",
      ...env,
    },
    timeout: 15_000,
  });
}

/** Read the JSON body from an MCP tool response. */
function payload(result) {
  return JSON.parse(result.content.find((part) => part.type === "text").text);
}

test("invalid access configuration fails before storage creation without exposing tokens", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalid = [
    { readToken: "reader-only" },
    { token: "same-secret", readToken: "same-secret" },
    { token: "hidden-admin\ninvalid" },
    { token: "admin", readToken: "hidden-reader\ninvalid" },
  ];
  for (const [index, auth] of invalid.entries()) {
    const dbPath = join(directory, String(index), "registry.sqlite");
    assert.throws(() => createApp({ dbPath, ...auth }), (error) => {
      assert.equal(error.message.includes("same-secret"), false);
      assert.equal(error.message.includes("hidden-admin"), false);
      assert.equal(error.message.includes("hidden-reader"), false);
      return true;
    });
    await assert.rejects(access(dbPath));
    assert.equal(serverOptionsSchema.safeParse(auth).success, false);
  }
});

test("read tokens permit reads and reject administrator operations with 403", async (t) => {
  const app = await fixture(t, options);
  const original = (await register(app, definition("docs"), admin)).json();
  for (const url of ["/api/targets", "/api/targets/docs", "/openapi.json"]) {
    assert.equal((await app.inject({ url, headers: read })).statusCode, 200, url);
  }
  assert.equal((await app.inject({ method: "HEAD", url: "/api/targets", headers: read })).statusCode, 200);
  const requests = [
    { method: "POST", url: "/api/targets", payload: definition("new") },
    { method: "PUT", url: "/api/targets/docs", payload: definition("docs", { name: "Blocked" }) },
    { method: "DELETE", url: "/api/targets/docs" },
    { method: "GET", url: "/api/registry/export" },
    { method: "HEAD", url: "/api/registry/export" },
    { method: "POST", url: "/api/registry/import?dryRun=true", payload: {} },
  ];
  for (const request of requests) {
    const response = await app.inject({ ...request, headers: read });
    assert.equal(response.statusCode, 403, request.method + " " + request.url);
    if (request.method === "HEAD") {
      assert.equal(response.body, "");
    } else {
      assert.equal(response.json().error.code, "FORBIDDEN");
    }
    assert.equal(response.headers["www-authenticate"], undefined);
  }
  assert.deepEqual((await app.inject({ url: "/api/targets/docs", headers: read })).json(), original);
  assert.equal((await app.inject({ url: "/api/targets/new", headers: read })).statusCode, 404);
  assert.equal((await register(app, definition("new"), admin)).statusCode, 201);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/targets/new", headers: admin })).statusCode, 204);
});

test("authentication precedes parsing while public health remains accessible", async (t) => {
  const app = await fixture(t, options);
  const malformed = {
    method: "POST", url: "/api/targets", payload: "{",
    headers: { "content-type": "application/json" },
  };
  assert.equal((await app.inject(malformed)).statusCode, 401);
  assert.equal((await app.inject({
    ...malformed, headers: { ...malformed.headers, ...read },
  })).statusCode, 403);
  assert.equal((await app.inject({
    ...malformed, headers: { ...malformed.headers, ...admin },
  })).statusCode, 400);
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject({
    url: "/api/targets", headers: { authorization: "Basic auth-admin-secret" },
  })).statusCode, 401);
  assert.equal((await app.inject({
    url: "/api/targets", headers: { authorization: "bearer   auth-reader-secret" },
  })).statusCode, 200);
});

test("new routes default to administrator access unless explicitly configured", async (t) => {
  const app = createApp(options);
  app.get("/future", async () => ({ ok: true }));
  t.after(async () => {
    await app.close();
  });
  assert.equal((await app.inject({ url: "/future", headers: read })).statusCode, 403);
  assert.equal((await app.inject({ url: "/future", headers: admin })).statusCode, 200);
  assert.equal((await app.inject("/future")).statusCode, 401);
  const anonymous = await fixture(t);
  assert.equal((await register(anonymous, definition())).statusCode, 201);
});

test("credential selection and hub clients do not expose invalid token values", () => {
  assert.equal(readClientToken(undefined, false, {}), undefined);
  assert.equal(readClientToken("CUSTOM_TOKEN", true, { CUSTOM_TOKEN: "valid-token" }), "valid-token");
  assert.throws(() => readClientToken("MISSING", true, {}), /environment variable is empty/);
  assert.throws(() => readClientToken("INVALID-NAME", true, {}), /environment variable name/);
  const secret = "hidden-value\ninvalid";
  for (const operation of [
    () => readClientToken("TOKEN", true, { TOKEN: secret }),
    () => new HubClient("http://127.0.0.1:1", secret),
  ]) {
    assert.throws(operation, (error) => {
      assert.match(error.message, /Hub tokens/);
      assert.equal(error.message.includes("hidden-value"), false);
      return true;
    });
  }
});

test("the CLI distinguishes read and administrator tokens from selected environment variables", async (t) => {
  const app = await fixture(t, options);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"), admin);
  const listed = JSON.parse((await cli([
    "target", "list", "--hub", hub, "--token-env", "READER_CREDENTIAL",
  ])).stdout);
  assert.equal(listed.total, 1);
  const directory = await temporaryDirectory(t);
  const input = join(directory, "target.json");
  const output = join(directory, "backup.json");
  await writeFile(input, JSON.stringify(definition("new")));
  await assert.rejects(cli([
    "target", "add", input, "--hub", hub, "--token-env", "READER_CREDENTIAL",
  ]), /403/);
  await assert.rejects(cli([
    "registry", "export", output, "--hub", hub, "--token-env", "READER_CREDENTIAL",
  ]), /403/);
  await assert.rejects(access(output));
  assert.equal(JSON.parse((await cli([
    "target", "add", input, "--hub", hub, "--token-env", "ADMIN_CREDENTIAL",
  ])).stdout).id, "new");
  await assert.rejects(cli([
    "target", "list", "--hub", hub, "--token-env", "MISSING_TOKEN",
  ]), /environment variable is empty/);
  await assert.rejects(cli(["serve", "--token-env", "ADMIN_CREDENTIAL"]), /Unsupported options/);
});

test("HTTP MCP clients can search and retrieve using a read token", async (t) => {
  const app = await fixture(t, options);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"), admin);
  const client = new Client({ name: "read-only-http", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", hub), {
    requestInit: { headers: read },
  }));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "get_target", "get_targets", "search_targets",
  ]);
  assert.equal(payload(await client.callTool({ name: "search_targets", arguments: {} })).total, 1);
  assert.equal(payload(await client.callTool({
    name: "get_target", arguments: { id: "docs" },
  })).id, "docs");
  assert.equal((await app.inject({ method: "DELETE", url: "/mcp", headers: read })).statusCode, 405);
});

test("stdio MCP uses the selected read token without falling back to the administrator token", async (t) => {
  const app = createApp(options);
  const seen = [];
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/targets")) {
      seen.push(request.headers.authorization);
    }
  });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });
  await register(app, definition("docs"), admin);
  seen.length = 0;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js"), "mcp", "--hub", hub, "--token-env", "READER_CREDENTIAL"],
    env: {
      AGENT_TCDH_TOKEN: "auth-admin-secret", READER_CREDENTIAL: "auth-reader-secret",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "read-only-stdio", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  assert.equal(payload(await client.callTool({ name: "search_targets", arguments: {} })).total, 1);
  assert.deepEqual(seen, ["Bearer auth-reader-secret"]);
});

test("OpenAPI describes route roles and administrator-only 403 responses", async (t) => {
  const app = await fixture(t, options);
  const spec = (await app.inject({ url: "/openapi.json", headers: read })).json();
  assert.equal(spec.paths["/health"].get["x-required-role"], "public");
  assert.equal(spec.paths["/api/targets"].get["x-required-role"], "read");
  assert.equal(spec.paths["/mcp"].post["x-required-role"], "read");
  for (const [path, method] of [
    ["/api/targets", "post"], ["/api/targets/{id}", "put"],
    ["/api/targets/{id}", "delete"], ["/api/registry/export", "get"], ["/api/registry/import", "post"],
  ]) {
    assert.equal(spec.paths[path][method]["x-required-role"], "admin");
    assert.ok(spec.paths[path][method].responses["403"]);
  }
  assert.equal(JSON.stringify(spec).includes("auth-admin-secret"), false);
  assert.equal(JSON.stringify(spec).includes("auth-reader-secret"), false);
});

test("serve applies administrator and read tokens and the public A2A URL", async (t) => {
  const directory = await temporaryDirectory(t);
  const allocator = createServer();
  await new Promise((resolve, reject) => {
    allocator.once("error", reject);
    allocator.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = allocator.address().port;
  await new Promise((resolve, reject) => {
    allocator.close((error) => error ? reject(error) : resolve());
  });
  const child = spawn(process.execPath, [
    resolve("dist/index.js"), "serve", "--host", "127.0.0.1", "--port", String(port),
    "--db", join(directory, "registry.sqlite"),
  ], {
    env: {
      ...process.env,
      AGENT_TCDH_TOKEN: "auth-admin-secret",
      AGENT_TCDH_READ_TOKEN: "auth-reader-secret",
      AGENT_TCDH_ALLOWED_ORIGINS: "",
      AGENT_TCDH_PUBLIC_URL: "https://hub.example.com/registry",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
  });
  const hub = "http://127.0.0.1:" + port;
  let ready = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      ready = (await fetch(hub + "/health")).ok;
    } catch {
      ready = false;
    }
    if (ready) {
      break;
    }
    await setTimeout(50);
  }
  assert.equal(ready, true, "serve 프로세스가 준비되어야 합니다.");
  assert.equal((await fetch(hub + "/api/targets", { headers: read })).status, 200);
  assert.equal((await fetch(hub + "/api/registry/export", { headers: read })).status, 403);
  const created = await fetch(hub + "/api/targets", {
    method: "POST", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify(definition("from-server")),
  });
  assert.equal(created.status, 201);
  const card = await fetch(hub + "/.well-known/agent-card.json", { headers: { "A2A-Version": "1.0" } });
  assert.equal((await card.json()).supportedInterfaces[0].url, "https://hub.example.com/registry/a2a");
  const discovery = await fetch(hub + "/a2a", {
    method: "POST", headers: { ...read, "content-type": "application/json", "A2A-Version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "serve-probe", method: "SendMessage", params: {
      message: { messageId: "serve-message", role: "ROLE_USER", parts: [{ text: "" }] },
    } }),
  });
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).result.message.parts[0].data.items[0].id, "from-server");
});
