import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { TargetStore } from "../dist/targets/store.js";
import { targetDefinitionSchema } from "../dist/targets/schema.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

/** Send a registry activity request through the authenticated API. */
async function request(app, method, url, payload, token = "admin", headers = {}) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { authorization: "Bearer " + token, ...headers } });
}

test("history records create/update/delete atomically and guarded undo produces new events", async (t) => {
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  const created = await register(app, definition(), { authorization: "Bearer admin" });
  assert.equal(created.statusCode, 201);
  const initial = (await request(app, "GET", "/api/registry/history")).json().items[0];
  assert.equal(initial.action, "insert");
  assert.equal((await request(app, "GET", "/api/registry/history", undefined, "reader")).statusCode, 403);
  assert.equal((await request(app, "GET", "/api/registry/history/" + initial.id, undefined, "reader")).statusCode, 403);
  assert.equal((await request(app, "POST", `/api/registry/history/${initial.id}/undo`, { apply: false })).json().ready, true);
  assert.equal((await app.inject("/api/targets/docs")).statusCode, 401);
  const update = await request(app, "PUT", "/api/targets/docs", definition("docs", { name: "Changed" }), "admin", { "if-match": created.headers.etag });
  assert.equal(update.statusCode, 200);
  const conflict = await request(app, "POST", `/api/registry/history/${initial.id}/undo`, { apply: true });
  assert.equal(conflict.statusCode, 412);
  const event = (await request(app, "GET", "/api/registry/history")).json().items[0];
  assert.equal((await request(app, "POST", `/api/registry/history/${event.id}/undo`, { apply: true })).json().applied, true);
  const restored = (await request(app, "GET", "/api/targets/docs")).json();
  assert.equal(restored.name, "Documentation");
  assert.notEqual((await request(app, "GET", "/api/targets/docs")).headers.etag, created.headers.etag);
  await request(app, "DELETE", "/api/targets/docs");
  const deletion = (await request(app, "GET", "/api/registry/history")).json().items[0];
  const detail = (await request(app, "GET", `/api/registry/history/${deletion.id}`)).json();
  assert.equal(detail.after, null);
  assert.equal(detail.before.id, "docs");
  assert.equal("afterRevision" in detail, false);
  assert.equal((await request(app, "POST", `/api/registry/history/${deletion.id}/undo`, { apply: true }, "reader")).statusCode, 403);
  assert.equal((await request(app, "POST", `/api/registry/history/${deletion.id}/undo`, { apply: true })).statusCode, 200);
  assert.equal((await request(app, "GET", "/api/targets/docs")).statusCode, 200);
});

test("deletion/recreation ABA and failed conditional writes cannot create misleading history", async (t) => {
  const app = await fixture(t);
  const created = await register(app, definition());
  await app.inject({ method: "DELETE", url: "/api/targets/docs" });
  const deletedId = (await app.inject("/api/registry/history")).json().items[0].id;
  await register(app, definition());
  await app.inject({ method: "DELETE", url: "/api/targets/docs" });
  const before = (await app.inject("/api/registry/history")).json();
  assert.equal((await app.inject({ method: "POST", url: `/api/registry/history/${deletedId}/undo`, payload: { apply: true } })).statusCode, 412);
  assert.equal((await app.inject({ method: "PUT", url: "/api/targets/docs", payload: definition(), headers: { "if-match": created.headers.etag } })).statusCode, 412);
  assert.deepEqual((await app.inject("/api/registry/history")).json(), before);
});

test("atomic imports and dry runs preserve transactional history and pagination", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  const snapshot = { format: "agent-tcdh", version: 1, exportedAt: new Date().toISOString(), targets: [definition("new"), definition()] };
  assert.equal((await app.inject({ method: "POST", url: "/api/registry/import", payload: snapshot })).statusCode, 409);
  assert.equal((await app.inject("/api/registry/history")).json().items.length, 1);
  await app.inject({ method: "POST", url: "/api/registry/import?onConflict=replace&dryRun=true", payload: snapshot });
  assert.equal((await app.inject("/api/registry/history")).json().items.length, 1);
  await app.inject({ method: "POST", url: "/api/registry/import?onConflict=replace", payload: snapshot });
  const first = (await app.inject("/api/registry/history?limit=2")).json();
  const next = (await app.inject("/api/registry/history?before=" + first.nextBefore)).json();
  assert.equal(first.items.length, 2);
  assert.equal(next.items.length, 1);
  assert.ok(first.items.every((item) => !Object.hasOwn(item, "before")));
  assert.equal((await app.inject("/api/registry/history?target=new")).json().items.length, 1);
});

test("history survives reopen, migrates existing v2 without fabricated events, and bounds retention", async (t) => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, "history.sqlite");
  const store = new TargetStore(path);
  store.create(targetDefinitionSchema.parse(definition()));
  store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TRIGGER history_insert; DROP TRIGGER history_update; DROP TRIGGER history_delete; DROP TABLE registry_history; DROP TABLE metadata_observations; PRAGMA user_version=2;");
  db.close();
  const migrated = new TargetStore(path);
  t.after(() => migrated.close());
  assert.equal(migrated.activity.history({ limit: 20 }).items.length, 0);
  assert.equal(migrated.get("docs").id, "docs");
  for (let index = 0; index < 1002; index++) {
    migrated.update("docs", targetDefinitionSchema.parse(definition("docs", { name: String(index) })));
  }
  const retained = migrated.activity.history({ limit: 100 });
  assert.equal(retained.items[0].id, 1002);
  assert.throws(() => migrated.activity.event(1), /expired/);
  const counts = new DatabaseSync(path);
  assert.equal(counts.prepare("SELECT count(*) AS n FROM registry_history").get().n, 1000);
  counts.close();
});

test("metadata observations require admin, a strong exact version, and report unknown/changed/stale independently", async (t) => {
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  const created = await register(app, definition(), { authorization: "Bearer admin" });
  const observation = { status: "failed", scope: "metadata", executionVerified: false };
  assert.equal((await request(app, "GET", "/api/registry/freshness", undefined, "reader")).json().items[0].state, "unknown");
  assert.equal((await request(app, "POST", "/api/targets/docs/observation", observation, "reader", { "if-match": created.headers.etag })).statusCode, 403);
  assert.equal((await request(app, "POST", "/api/targets/docs/observation", observation)).statusCode, 400);
  assert.equal((await request(app, "POST", "/api/targets/docs/observation", { ...observation, executionVerified: true }, "admin", { "if-match": created.headers.etag })).statusCode, 400);
  assert.equal((await request(app, "POST", "/api/targets/docs/observation", observation, "admin", { "if-match": created.headers.etag })).statusCode, 200);
  const fresh = (await request(app, "GET", "/api/registry/freshness", undefined, "reader")).json().items[0];
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.source, "consumer-report");
  assert.equal((await request(app, "GET", "/api/registry/freshness?staleHours=0")).json().items[0].state, "stale");
  await request(app, "PUT", "/api/targets/docs", definition("docs", { name: "edited" }));
  assert.equal((await request(app, "GET", "/api/registry/freshness")).json().items[0].state, "changed");
  assert.equal((await request(app, "POST", "/api/targets/docs/observation", observation, "admin", { "if-match": created.headers.etag })).statusCode, 412);
  await request(app, "DELETE", "/api/targets/docs");
  await register(app, definition(), { authorization: "Bearer admin" });
  assert.equal((await request(app, "GET", "/api/registry/freshness")).json().items[0].state, "unknown");
});

test("history byte retention counts UTF-8 bytes and schema upgrade failures preserve version 2", async (t) => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, "bytes.sqlite");
  const store = new TargetStore(path);
  const large = targetDefinitionSchema.parse(definition("large", { capabilities: Array.from({ length: 80 }, (_, i) => ({ name: "tool" + i, description: "漢".repeat(3000) })) }));
  store.create(large);
  for (let i = 0; i < 16; i++) {
    store.update("large", { ...large, name: "Revision " + i });
  }
  store.close();
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT count(*) AS n, sum(length(CAST(COALESCE(before_definition,'') AS BLOB))+length(CAST(COALESCE(after_definition,'') AS BLOB))+512) AS bytes FROM registry_history").get();
  assert.ok(row.bytes <= 16777216);
  assert.ok(row.n < 17);
  db.exec("PRAGMA user_version=2; DROP TABLE metadata_observations; CREATE VIEW metadata_observations AS SELECT 1 AS target_id;");
  db.close();
  assert.throws(() => new TargetStore(path));
  const reopened = new DatabaseSync(path);
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM targets").get().n, 1);
  reopened.close();
});

test("competing undo requests have one winner and metadata APIs are documented with matching access roles", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  const id = (await app.inject("/api/registry/history")).json().items[0].id;
  const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/api/registry/history/${id}/undo`, payload: { apply: true } })));
  assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 412]);
  const paths = (await app.inject("/openapi.json")).json().paths;
  assert.equal(paths["/api/registry/history"].get["x-required-role"], "admin");
  assert.equal(paths["/api/registry/freshness"].get["x-required-role"], "read");
  assert.equal(paths["/api/targets/{id}/observation"].post["x-required-role"], "admin");
});
