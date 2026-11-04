import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { batchTargetOptionsSchema, selectBatchTargets } from "../dist/targets/batch.js";
import { refreshBatch } from "../dist/targets/refresh-batch.js";
import { diagnoseBatch } from "../dist/onboarding/doctor-batch.js";
import { fixture, register, definition, temporaryDirectory } from "./helpers.mjs";
import { mcpSource, cardSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const tools = [{ name: "selected_tool", description: "Selected metadata", inputSchema: { type: "object" } }];

/** Run commands without using contributor setup defaults or credentials. */
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

/** Register stale remote capabilities for direct-ID selection tests. */
async function remote(app, source, id, overrides = {}, headers = {}) {
  const response = await register(app, definition(id, { capabilities: [],
    connection: { transport: "streamable-http", url: source.url + "/mcp" }, ...overrides }), headers);
  assert.equal(response.statusCode, 201);
}

test("explicit mixed IDs retain input order and update only their current registrations without catalog enumeration", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  const peer = await cardSource(t, async () => ({ name: "Peer", description: "Selected peer", url: "https://peer.example/new-a2a", skills: [] }));
  await remote(app, source, "docs");
  await remote(app, source, "unselected");
  await register(app, definition("peer", { protocol: "a2a", capabilities: [],
    connection: { transport: "http", url: "https://peer.example/old-a2a", agentCardUrl: peer.url + "/custom-card" } }));
  const client = new HubClient(hub);
  client.search = async () => { assert.fail("Explicit membership must not enumerate discovery pages."); };
  const unselected = await client.getVersioned("unselected");
  const options = batchTargetOptionsSchema.parse({ select: ["peer", "docs"] });
  const preview = await refreshBatch(client, options);
  assert.equal(preview.summary.planned, 2);
  assert.deepEqual(preview.targets.map((target) => target.id), ["peer", "docs"]);
  assert.equal((await client.get("docs")).capabilities.length, 0);
  const applied = await refreshBatch(client, options, true);
  assert.equal(applied.summary.updated, 2);
  assert.deepEqual(applied.targets.map((target) => target.id), ["peer", "docs"]);
  const diagnosis = await diagnoseBatch(client, options);
  assert.equal(diagnosis.complete, true);
  assert.deepEqual(diagnosis.targets.map((target) => target.id), ["peer", "docs"]);
  assert.equal(diagnosis.summary.passed, 2);
  assert.deepEqual(await client.getVersioned("unselected"), unselected);
  assert.equal(source.state.calls, 0);
  assert.equal(source.state.listCalls, 3);
});

test("an unavailable explicit ID rejects the whole selection before metadata requests or updates", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  await remote(app, source, "known");
  const client = new HubClient(hub);
  const before = await client.getVersioned("known");
  const options = batchTargetOptionsSchema.parse({ select: ["known", "missing"] });
  for (const run of [() => refreshBatch(client, options, true), () => diagnoseBatch(client, options)]) {
    const report = await run();
    assert.equal(report.matched, 2);
    assert.equal(report.complete, false);
    assert.deepEqual(report.targets, []);
    assert.equal(report.selectionIssue.code, "SELECTION_TARGET_UNAVAILABLE");
    assert.match(report.selectionIssue.message, /missing/);
  }
  assert.equal(source.state.listCalls, 0);
  assert.deepEqual(await client.getVersioned("known"), before);
  const get = client.getVersioned.bind(client);
  client.getVersioned = async (id) => {
    if (id === "missing") {
      throw new Error("private-hub-error-body");
    }
    return get(id);
  };
  assert.doesNotMatch(JSON.stringify(await selectBatchTargets(client, options)), /private-hub-error-body/);
  client.getVersioned = async () => before;
  const wrongId = await selectBatchTargets(client, batchTargetOptionsSchema.parse({ select: ["missing"] }));
  assert.equal(wrongId.issue.code, "SELECTION_TARGET_UNAVAILABLE");
});

test("explicit IDs require include-disabled before any provider work for a mixed group", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  await remote(app, source, "active");
  await remote(app, source, "disabled", { enabled: false });
  const client = new HubClient(hub);
  const blocked = await refreshBatch(client, batchTargetOptionsSchema.parse({ select: ["active", "disabled"] }), true);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.selectionIssue.code, "SELECTION_TARGET_DISABLED");
  assert.equal(source.state.listCalls, 0);
  assert.equal((await client.get("active")).capabilities.length, 0);
  const included = await refreshBatch(client, batchTargetOptionsSchema.parse({ select: ["disabled", "active"], includeDisabled: true }), true);
  assert.equal(included.summary.updated, 2);
  assert.equal((await client.get("disabled")).enabled, false);
});

test("explicit selection caps and invalid requests fail before registry reads", async () => {
  let lookups = 0;
  const client = { search: async () => { assert.fail("No discovery expected."); }, getVersioned: async () => { lookups++; throw new Error("must not read"); } };
  const selected = Array.from({ length: 101 }, (_, index) => "id-" + index);
  const report = await selectBatchTargets(client, batchTargetOptionsSchema.parse({ select: selected }));
  assert.equal(report.matched, 101);
  assert.equal(report.issue.code, "SELECTION_LIMIT_EXCEEDED");
  assert.equal(lookups, 0);
  for (const options of [{ select: [] }, { select: ["same", "same"] }, { select: ["../invalid"] }, { select: selected.concat(Array.from({ length: 900 }, (_, i) => "other-" + i)) },
    { select: ["one"], q: "query" }, { select: ["one"], protocol: "mcp" }, { select: ["one"], tag: "team" }]) {
    await assert.rejects(selectBatchTargets(client, options));
  }
  assert.equal(lookups, 0);
});

test("explicit workers remain bounded and report later removals independently", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  let active = 0;
  let peak = 0;
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }], onList: async () => {
    active++;
    peak = Math.max(peak, active);
    await setTimeout(30);
    active--;
  } });
  for (const id of ["one", "two", "three", "removed"]) {
    await remote(app, source, id);
  }
  const client = new HubClient(hub);
  const get = client.getVersioned.bind(client);
  const reads = new Map();
  client.getVersioned = async (id) => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    if (id === "removed" && reads.get(id) === 2) {
      await client.remove(id);
    }
    return get(id);
  };
  const report = await refreshBatch(client, batchTargetOptionsSchema.parse({ select: ["three", "removed", "one", "two"], concurrency: 2 }), true);
  assert.equal(report.complete, true);
  assert.equal(report.summary.updated, 3);
  assert.equal(report.summary.failed, 1);
  assert.equal(peak, 2);
  assert.deepEqual(report.targets.map((target) => target.id), ["three", "removed", "one", "two"]);
  assert.equal(source.state.calls, 0);
});

test("CLI explicit diagnosis and refresh preview use read credentials and apply requires admin", async (t) => {
  const app = await fixture(t, { token: "private-admin", readToken: "private-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools }] });
  for (const id of ["chosen", "another", "unselected"]) {
    await remote(app, source, id, {}, { Authorization: "Bearer private-admin" });
  }
  const file = join(await temporaryDirectory(t), "setup.json");
  await writeFile(file, JSON.stringify({ formatVersion: 1, mode: "remote", hub, readTokenEnv: "READER",
    server: { host: "127.0.0.1", port: 3000, dbPath: "unused.sqlite" } }));
  const environment = { READER: "private-reader", ADMIN: "private-admin" };
  const selection = ["--select", "another", "--select", "chosen", "--config", file];
  const diagnosed = await cli(["doctor", ...selection], environment);
  assert.equal(diagnosed.code, 0, diagnosed.stderr);
  assert.deepEqual(JSON.parse(diagnosed.stdout).batch.targets.map((target) => target.id), ["another", "chosen"]);
  const preview = await cli(["target", "refresh", ...selection], environment);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).summary.planned, 2);
  const beforeDenied = source.state.listCalls;
  const denied = await cli(["target", "refresh", ...selection, "--apply"], environment);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /administrator credential/);
  assert.equal(source.state.listCalls, beforeDenied);
  const applied = await cli(["target", "refresh", ...selection, "--apply", "--token-env", "ADMIN"], environment);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).summary.updated, 2);
  const client = new HubClient(hub, "private-reader");
  assert.equal((await client.get("unselected")).capabilities.length, 0);
  assert.doesNotMatch(diagnosed.stdout + preview.stdout + applied.stdout, /private-admin|private-reader/);
  const missing = await cli(["target", "refresh", "--select", "chosen", "--select", "missing", "--config", file], environment);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).selectionIssue.code, "SELECTION_TARGET_UNAVAILABLE");
});

test("CLI rejects mixed selection modes, discovery filters, duplicates, and invalid IDs before contacting a hub", async () => {
  const cases = [
    ["doctor", "--all", "--select", "one"], ["doctor", "--target", "one", "--select", "two"],
    ["doctor", "--select", "one", "--q", ""], ["doctor", "--select", "one", "--protocol", "mcp"],
    ["doctor", "--select", "one", "--select", "one"], ["doctor", "--select", "../invalid"],
    ["target", "refresh", "one", "--select", "two"], ["target", "refresh", "--all", "--select", "one"],
    ["target", "refresh", "--select", "one", "--tag", "team"], ["target", "refresh", "--select", "one", "--q", ""],
    ["target", "refresh", "--select", "one", "--select", "one"], ["target", "refresh", "--select", "../invalid"],
    ["target", "refresh", "--select", "one", "--bearer-env", "PROVIDER"], ["target", "refresh", "--select", "one", "--apply", "--dry-run"],
  ];
  for (const args of cases) {
    const result = await cli([...args, "--hub", "http://127.0.0.1:1"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /fetch failed/);
  }
});
