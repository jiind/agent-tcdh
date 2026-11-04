import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { refreshBatch } from "../dist/targets/refresh-batch.js";
import { batchTargetOptionsSchema } from "../dist/targets/batch.js";
import { fixture, register, definition, temporaryDirectory } from "./helpers.mjs";
import { mcpSource, cardSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const tools = [{ name: "current_tool", description: "Current metadata", inputSchema: { type: "object" } }];

/** Invoke the CLI using isolated credentials rather than contributor configuration. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  try {
    return { ...(await execute(process.execPath, [resolve("dist/index.js"), ...args], { env: { ...env, ...environment }, timeout: 30_000 })), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return error;
  }
}

/** Register a remote metadata fixture with deliberately stale capabilities. */
async function remote(app, source, id, overrides = {}, headers = {}) {
  const response = await register(app, definition(id, { capabilities: [],
    connection: { transport: "streamable-http", url: source.url + "/mcp" }, ...overrides }), headers);
  assert.equal(response.statusCode, 201);
}

test("batch refresh previews mixed MCP/A2A metadata and explicitly applies changed definitions without execution", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  await remote(app, source, "remote");
  let cardRequests = 0;
  const peer = await cardSource(t, async () => {
    cardRequests++;
    return { name: "Peer", description: "Agent metadata", url: "https://peer.example/new-a2a", skills: [{ id: "research", name: "Research", description: "Research", tags: [] }] };
  });
  await register(app, definition("peer", { protocol: "a2a", capabilities: [], name: "Managed name", tags: ["managed"],
    connection: { transport: "http", url: "https://peer.example/old-a2a", agentCardUrl: peer.url + "/custom-card" } }));
  const marker = join(await temporaryDirectory(t), "never-execute");
  await register(app, definition("local", { connection: { transport: "stdio", command: process.execPath,
    args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')"] } }));
  await remote(app, source, "oauth", { connection: { transport: "streamable-http", url: source.url + "/mcp", auth: { type: "oauth2" } } });
  const client = new HubClient(hub);
  const before = await client.getVersioned("remote");
  const preview = await refreshBatch(client, batchTargetOptionsSchema.parse({}));
  assert.equal(preview.complete, true);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.summary, { planned: 2, updated: 0, unchanged: 0, skipped: 2, failed: 0 });
  assert.deepEqual(await client.getVersioned("remote"), before);
  assert.equal(preview.targets.find((target) => target.id === "peer").fields.includes("connection"), true);
  const applied = await refreshBatch(client, batchTargetOptionsSchema.parse({}), true);
  assert.deepEqual(applied.summary, { planned: 0, updated: 2, unchanged: 0, skipped: 2, failed: 0 });
  assert.deepEqual((await client.get("remote")).capabilities, tools);
  const savedPeer = await client.get("peer");
  assert.equal(savedPeer.connection.url, "https://peer.example/new-a2a");
  assert.equal(savedPeer.name, "Managed name");
  assert.deepEqual(savedPeer.tags, ["managed"]);
  const updated = await client.getVersioned("remote");
  assert.notEqual(updated.etag, before.etag);
  const noOp = await refreshBatch(client, batchTargetOptionsSchema.parse({}), true);
  assert.equal(noOp.summary.unchanged, 2);
  assert.equal(noOp.summary.updated, 0);
  assert.deepEqual(await client.getVersioned("remote"), updated);
  assert.ok(applied.targets.every((target) => target.executionVerified === false));
  assert.equal(source.state.calls, 0);
  assert.equal(source.state.listCalls, 3);
  assert.equal(cardRequests, 3);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("per-target provider credentials are isolated and missing or ambiguous credentials do not leak values", async (t) => {
  const app = await fixture(t, { token: "private-admin", readToken: "private-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, token: "private-provider", pages: [{ tools }] });
  for (const [id, envVars] of [["secured", ["PROVIDER"]], ["missing", ["ABSENT"]], ["ambiguous", ["ONE", "TWO"]]]) {
    await remote(app, source, id, { connection: { transport: "streamable-http", url: source.url + "/mcp", auth: { type: "bearer", envVars } } }, { Authorization: "Bearer private-admin" });
  }
  const client = new HubClient(hub, "private-reader");
  const report = await refreshBatch(client, batchTargetOptionsSchema.parse({}), false, { PROVIDER: "private-provider" });
  assert.deepEqual(report.summary, { planned: 1, updated: 0, unchanged: 0, skipped: 1, failed: 1 });
  assert.equal(report.status, "failed");
  assert.ok(source.state.headers.every((header) => header === "Bearer private-provider"));
  assert.equal(source.state.listCalls, 1);
  assert.equal(source.state.calls, 0);
  assert.doesNotMatch(JSON.stringify(report), /private-admin|private-reader|private-provider/);
  assert.equal(report.targets.find((target) => target.id === "ambiguous").issue.code, "BEARER_ENV_REQUIRED");
  assert.equal((await client.get("secured")).capabilities.length, 0);
});

test("batch filters exclude disabled targets and include them only when requested", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  await remote(app, source, "chosen", { tags: ["team"] });
  await remote(app, source, "disabled", { tags: ["team"], enabled: false });
  await remote(app, source, "other", { tags: ["other"] });
  const client = new HubClient(hub);
  const disabled = await client.getVersioned("disabled");
  const report = await refreshBatch(client, batchTargetOptionsSchema.parse({ protocol: "mcp", tag: "team" }), true);
  assert.deepEqual(report.targets.map((target) => target.id), ["chosen"]);
  assert.deepEqual(await client.getVersioned("disabled"), disabled);
  assert.equal((await client.get("other")).capabilities.length, 0);
  const included = await refreshBatch(client, batchTargetOptionsSchema.parse({ tag: "team", includeDisabled: true }), true);
  assert.equal(included.summary.updated, 1);
  assert.equal((await client.get("disabled")).enabled, false);
  const empty = await refreshBatch(client, batchTargetOptionsSchema.parse({ protocol: "a2a" }));
  assert.equal(empty.status, "warning");
  assert.equal(empty.complete, true);
  assert.equal(empty.matched, 0);
});

test("selection caps and inconsistent pages stop before target reads, metadata probes, or writes", async () => {
  const timestamp = "2026-10-30T00:00:00Z";
  const targets = Array.from({ length: 105 }, (_, index) => ({ ...definition("n" + index), createdAt: timestamp, updatedAt: timestamp }));
  let reads = 0;
  let writes = 0;
  const client = { search: async ({ offset }) => ({ items: targets.slice(offset, offset + 100), total: 105, limit: 100, offset }),
    getVersioned: async () => { reads++; throw new Error("private-read-error"); }, update: async () => { writes++; } };
  const blocked = await refreshBatch(client, batchTargetOptionsSchema.parse({}), true);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.selectionIssue.code, "SELECTION_LIMIT_EXCEEDED");
  assert.equal(reads, 0);
  const selected = await refreshBatch(client, batchTargetOptionsSchema.parse({ limit: 105 }));
  assert.equal(selected.targets.length, 105);
  assert.equal(selected.summary.failed, 105);
  assert.equal(reads, 105);
  reads = 0;
  client.search = async ({ offset }) => ({ items: targets.slice(offset, offset + 100), total: offset ? 106 : 105, limit: 100, offset });
  assert.equal((await refreshBatch(client, batchTargetOptionsSchema.parse({ limit: 200 }), true)).selectionIssue.code, "SELECTION_CHANGED");
  client.search = async () => { throw new Error("private-discovery-body"); };
  const unavailable = await refreshBatch(client, batchTargetOptionsSchema.parse({}), true);
  assert.equal(unavailable.selectionIssue.code, "DISCOVERY_FAILED");
  assert.doesNotMatch(JSON.stringify(unavailable), /private-/);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("metadata concurrency is bounded and results retain discovery order", { timeout: 15_000 }, async (t) => {
  let active = 0;
  let peak = 0;
  let ordinal = 0;
  const completed = [];
  const first = Promise.withResolvers();
  t.after(() => first.resolve());
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }], onList: async () => {
    const index = ordinal++;
    active++;
    peak = Math.max(peak, active);
    // Hold one worker until the other has reached the final target, independent of runner speed.
    try {
      if (index === 0) {
        await first.promise;
      } else if (index === 4) {
        first.resolve();
      }
      completed.push(index);
    } finally {
      active--;
    }
  } });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const id of ["one", "two", "three", "four", "five"]) {
    await remote(app, source, id);
  }
  const client = new HubClient(hub);
  const expected = (await client.search({ limit: 100 })).items.map((target) => target.id);
  let reads = 0;
  let peakReads = 0;
  const monitored = {
    search: (options) => client.search(options),
    // Initial reads are dispatched before awaiting network responses, exposing excess workers reliably.
    getVersioned: async (id) => {
      reads++;
      peakReads = Math.max(peakReads, reads);
      try {
        return await client.getVersioned(id);
      } finally {
        reads--;
      }
    },
    update: (...args) => client.update(...args),
  };
  const report = await refreshBatch(monitored, batchTargetOptionsSchema.parse({ concurrency: 2 }));
  assert.equal(peakReads, 2);
  assert.equal(peak, 2);
  assert.deepEqual(completed, [1, 2, 3, 4, 0]);
  assert.deepEqual(report.targets.map((target) => target.id), expected);
  assert.equal(report.summary.planned, 5);
});

test("concurrent label edits survive metadata refresh while a disable prevents the write", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }], onList: async () => {
    const current = await client.get("labels");
    await client.update("labels", { ...definition("labels"), ...current, createdAt: undefined, updatedAt: undefined,
      name: "Concurrent administrator label", tags: ["updated"], connection: current.connection });
  } });
  await remote(app, source, "labels");
  const report = await refreshBatch(client, batchTargetOptionsSchema.parse({}), true);
  assert.equal(report.summary.updated, 1);
  assert.equal((await client.get("labels")).name, "Concurrent administrator label");
  assert.deepEqual((await client.get("labels")).tags, ["updated"]);
  const disabledSource = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }], onList: async () => {
    await client.update("disable", definition("disable", { enabled: false, capabilities: [], connection: { transport: "streamable-http", url: disabledSource.url + "/mcp" } }));
  } });
  await remote(app, disabledSource, "disable");
  const disabled = await refreshBatch(client, batchTargetOptionsSchema.parse({ q: "disable" }), true);
  assert.equal(disabled.targets[0].status, "skipped");
  assert.equal(disabled.targets[0].issue.code, "TARGET_DISABLED");
  assert.equal((await client.get("disable")).capabilities.length, 0);
});

test("connection changes during inspection fail safely and leave the changed endpoint intact", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }], onList: async () => {
    await client.update("changed", definition("changed", { capabilities: [], connection: { transport: "streamable-http", url: "http://127.0.0.1:1/changed" } }));
  } });
  await remote(app, source, "changed");
  const report = await refreshBatch(client, batchTargetOptionsSchema.parse({}), true);
  assert.equal(report.summary.failed, 1);
  assert.equal((await client.get("changed")).connection.url, "http://127.0.0.1:1/changed");
  assert.equal((await client.get("changed")).capabilities.length, 0);
});

test("a conditional-write conflict is not retried and does not prevent independent successes", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  await remote(app, source, "a-conflict");
  await remote(app, source, "b-success");
  const client = new HubClient(hub);
  const update = client.update.bind(client);
  let attempts = 0;
  client.update = async (id, target, etag) => {
    attempts++;
    assert.ok(etag);
    if (id === "a-conflict") {
      await update(id, definition(id, { name: "Concurrent writer", capabilities: [], connection: target.connection }));
    }
    return update(id, target, etag);
  };
  const report = await refreshBatch(client, batchTargetOptionsSchema.parse({ concurrency: 1 }), true);
  assert.equal(report.status, "failed");
  assert.equal(report.complete, true);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.updated, 1);
  assert.equal(report.targets.find((target) => target.id === "a-conflict").issue.code, "UPDATE_CONFLICT");
  assert.equal(attempts, 2);
  assert.equal((await client.get("a-conflict")).name, "Concurrent writer");
  assert.equal((await client.get("a-conflict")).capabilities.length, 0);
  assert.deepEqual((await client.get("b-success")).capabilities, tools);
});

test("CLI previews prefer setup read credentials and explicit admin application updates only changed targets", async (t) => {
  const app = await fixture(t, { token: "private-admin", readToken: "private-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  await remote(app, source, "remote", {}, { Authorization: "Bearer private-admin" });
  const client = new HubClient(hub, "private-reader");
  const file = join(await temporaryDirectory(t), "setup.json");
  await writeFile(file, JSON.stringify({ formatVersion: 1, mode: "remote", hub, readTokenEnv: "READER",
    server: { host: "127.0.0.1", port: 3000, dbPath: "unused.sqlite" } }));
  const args = ["target", "refresh", "--all", "--config", file];
  const environment = { READER: "private-reader", ADMIN: "private-admin" };
  const before = await client.getVersioned("remote");
  const preview = await cli(args, environment);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).summary.planned, 1);
  assert.deepEqual(await client.getVersioned("remote"), before);
  const calls = source.state.listCalls;
  const denied = await cli([...args, "--apply"], environment);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /administrator credential/);
  assert.equal(source.state.listCalls, calls);
  const applied = await cli([...args, "--apply", "--token-env", "ADMIN"], environment);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).summary.updated, 1);
  const current = await client.getVersioned("remote");
  const noOp = await cli([...args, "--apply", "--token-env", "ADMIN"], environment);
  assert.equal(JSON.parse(noOp.stdout).summary.unchanged, 1);
  assert.deepEqual(await client.getVersioned("remote"), current);
  assert.doesNotMatch(preview.stdout + applied.stdout, /private-admin|private-reader/);
  const single = await cli(["target", "refresh", "remote", "--hub", hub, "--token-env", "ADMIN"], environment);
  assert.equal(single.code, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).id, "remote");
  assert.notEqual((await client.getVersioned("remote")).etag, current.etag);
});

test("CLI rejects mixed selectors, credential overrides, and invalid batch limits before provider calls", async () => {
  for (const extra of [["remote", "--all"], ["--all", "--apply", "--dry-run"], ["--all", "--bearer-env", "PROVIDER"],
    ["--all", "--a2a-version", "1.0"], ["--all", "--limit", "0"], ["--all", "--limit", "1001"],
    ["--all", "--concurrency", "9"], ["--all", "--concurrency", "1.5"], ["remote", "--concurrency", "2"], ["remote", "--apply"]]) {
    const result = await cli(["target", "refresh", ...extra, "--hub", "http://127.0.0.1:1"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /fetch failed/);
  }
});
