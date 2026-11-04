import assert from "node:assert/strict";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { manageDuplicates } from "../dist/registry/duplicates.js";
import { fixture, register, definition } from "./helpers.mjs";

/** Prepare equivalent and intentionally distinct registrations without contacting their providers. */
async function setup(t) {
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub, "admin");
  for (const [id, overrides] of [["keep", {}], ["duplicate", { name: "Other label", capabilities: [] }], ["disabled", { enabled: false }],
    ["credential", { connection: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp", auth: { type: "bearer", envVars: ["DIFFERENT"] } } }]]) {
    assert.equal((await register(app, definition(id, overrides), { Authorization: "Bearer admin" })).statusCode, 201);
  }
  return { client, reader: new HubClient(hub, "reader") };
}

test("duplicate preview reports label/metadata differences without conflating disabled or differently authenticated connections", async (t) => {
  const { client, reader } = await setup(t);
  const report = await manageDuplicates(reader, {});
  assert.equal(report.applied, false);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(new Set(report.groups[0].ids), new Set(["keep", "duplicate"]));
  assert.deepEqual(report.groups[0].differingFields, ["name", "capabilities"]);
  assert.equal((await client.search({ includeDisabled: true })).total, 4);
});

test("cleanup requires explicit compatible IDs and removes only selected versions while preserving its representative", async (t) => {
  const { client } = await setup(t);
  const before = await client.getVersioned("keep");
  await assert.rejects(manageDuplicates(client, { apply: true }), /--keep/);
  await assert.rejects(manageDuplicates(client, { keep: "keep", remove: ["keep"], apply: true }), /representative/);
  const incompatible = await manageDuplicates(client, { keep: "keep", remove: ["credential"], apply: true });
  assert.equal(incompatible.applied, false);
  const preview = await manageDuplicates(client, { keep: "keep", remove: ["duplicate"] });
  assert.equal(preview.applied, false);
  const result = await manageDuplicates(client, { keep: "keep", remove: ["duplicate"], apply: true });
  assert.equal(result.ready, true);
  assert.deepEqual(result.outcomes, [{ id: "duplicate", status: "removed" }]);
  await assert.rejects(client.get("duplicate"), /HTTP 404/);
  assert.equal((await client.getVersioned("keep")).etag, before.etag);
  assert.equal((await client.search({ includeDisabled: true })).total, 3);
});

test("a changed representative stops cleanup before deletion and preserves concurrent administrator changes", async (t) => {
  const { client } = await setup(t);
  let reads = 0;
  let removals = 0;
  const observed = { search: (options) => client.search(options), getVersioned: async (id) => {
    if (id === "keep" && ++reads === 3) {
      const current = await client.get(id);
      await client.update(id, { ...current, createdAt: undefined, updatedAt: undefined, name: "Concurrent representative" });
    }
    return client.getVersioned(id);
  }, remove: async (id, etag) => { removals++; return client.remove(id, etag); } };
  const report = await manageDuplicates(observed, { keep: "keep", remove: ["duplicate"], apply: true });
  assert.equal(report.ready, false);
  assert.equal(removals, 0);
  assert.equal((await client.get("duplicate")).id, "duplicate");
  assert.equal((await client.get("keep")).name, "Concurrent representative");
});

test("concurrent duplicate changes fail their conditional removal without retries", async (t) => {
  const { client } = await setup(t);
  let attempts = 0;
  const observed = { search: (options) => client.search(options), getVersioned: (id) => client.getVersioned(id),
    remove: async (id, etag) => {
      attempts++;
      const current = await client.get(id);
      await client.update(id, { ...current, createdAt: undefined, updatedAt: undefined, name: "Concurrent duplicate" });
      return client.remove(id, etag);
    } };
  const report = await manageDuplicates(observed, { keep: "keep", remove: ["duplicate"], apply: true });
  assert.equal(report.ready, false);
  assert.equal(attempts, 1);
  assert.equal(report.outcomes[0].issue, "CONDITIONAL_REMOVAL_FAILED");
  assert.equal((await client.get("duplicate")).name, "Concurrent duplicate");
});
