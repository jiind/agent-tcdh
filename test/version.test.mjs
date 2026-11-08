import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { HubClient } from "../dist/client.js";
import { targetDefinitionSchema } from "../dist/targets/schema.js";
import { TargetStore } from "../dist/targets/store.js";
import { parseIfMatch } from "../dist/targets/version.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";
import { mcpSource } from "./import-helpers.mjs";

const execute = promisify(execFile);

/** Build a legacy table and stored definition to exercise the real migration path. */
function legacyDatabase(path, failMigration = false) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE targets (
      id TEXT PRIMARY KEY, protocol TEXT NOT NULL, enabled INTEGER NOT NULL,
      definition TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  const target = targetDefinitionSchema.parse(definition("legacy"));
  database.prepare("INSERT INTO targets VALUES (?, ?, ?, ?, ?, ?)")
    .run(target.id, target.protocol, Number(target.enabled), JSON.stringify(target),
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  if (failMigration) {
    database.exec(`
      CREATE TRIGGER block_migration BEFORE UPDATE ON targets
      BEGIN SELECT RAISE(ABORT, 'blocked migration'); END;
    `);
  }
  database.close();
  return target;
}

/** Run the administrative CLI in a separate process. */
async function cli(args) {
  return execute(process.execPath, [resolve("dist/index.js"), ...args], {
    env: { ...process.env, AGENT_TCDH_TOKEN: "" }, timeout: 15_000,
  });
}

test("creation, retrieval, and update ETags distinguish revisions without changing response bodies", async (t) => {
  const app = await fixture(t);
  const created = await register(app, definition());
  const first = created.headers.etag;
  assert.match(first, /^"[0-9a-f-]+"$/);
  assert.equal("revision" in created.json(), false);
  const read = await app.inject("/api/targets/docs");
  assert.equal(read.headers.etag, first);
  assert.deepEqual(read.json(), created.json());
  assert.equal((await app.inject({ method: "HEAD", url: "/api/targets/docs" })).headers.etag, first);
  const changed = await app.inject({
    method: "PUT", url: "/api/targets/docs", payload: definition("docs", { name: "Changed" }),
  });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, first);
  assert.equal((await app.inject("/api/targets/docs")).headers.etag, changed.headers.etag);
});

test("only one update for a shared version succeeds and stale writes preserve current data", async (t) => {
  const app = await fixture(t);
  const first = (await register(app, definition())).headers.etag;
  const request = {
    method: "PUT", url: "/api/targets/docs", headers: { "if-match": first },
    payload: definition("docs", { name: "Winner" }),
  };
  const updated = await app.inject(request);
  assert.equal(updated.statusCode, 200);
  const stale = await app.inject({ ...request, payload: definition("docs", { name: "Stale" }) });
  assert.equal(stale.statusCode, 412);
  assert.equal(stale.json().error.code, "PRECONDITION_FAILED");
  assert.deepEqual((await app.inject("/api/targets/docs")).json(), updated.json());
  assert.equal((await app.inject("/api/targets/docs")).headers.etag, updated.headers.etag);
});

test("conditional deletion and wildcards return 412 or 204 based on existence and revisions", async (t) => {
  const app = await fixture(t);
  const first = (await register(app, definition())).headers.etag;
  assert.equal((await app.inject({
    method: "DELETE", url: "/api/targets/docs", headers: { "if-match": '"wrong"' },
  })).statusCode, 412);
  assert.equal((await app.inject({
    method: "DELETE", url: "/api/targets/docs", headers: { "if-match": first },
  })).statusCode, 204);
  assert.equal((await app.inject({
    method: "DELETE", url: "/api/targets/docs", headers: { "if-match": "*" },
  })).statusCode, 412);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/targets/docs" })).statusCode, 404);
  assert.equal((await app.inject({
    method: "PUT", url: "/api/targets/missing", headers: { "if-match": "*" }, payload: definition("missing"),
  })).statusCode, 412);
});

test("If-Match accepts strong tag lists and rejects weak or empty matches", async (t) => {
  const app = await fixture(t);
  let current = (await register(app, definition())).headers.etag;
  for (const value of ['W/' + current, "", ", ,", '"other"']) {
    const response = await app.inject({
      method: "PUT", url: "/api/targets/docs", headers: { "if-match": value }, payload: definition(),
    });
    assert.equal(response.statusCode, 412, value);
  }
  const list = await app.inject({
    method: "PUT", url: "/api/targets/docs",
    headers: { "if-match": '"not,current", W/' + current + ", " + current },
    payload: definition(),
  });
  assert.equal(list.statusCode, 200);
  current = list.headers.etag;
  for (const value of ["unquoted", '*,' + current, '"unfinished', '"one" "two"', "x".repeat(4097)]) {
    const invalid = await app.inject({
      method: "DELETE", url: "/api/targets/docs", headers: { "if-match": value },
    });
    assert.equal(invalid.statusCode, 400, value.slice(0, 50));
  }
  assert.equal((await app.inject("/api/targets/docs")).headers.etag, current);
  assert.deepEqual(parseIfMatch('"tag,with,commas", W/"ignored", "good"'), {
    kind: "tags", tags: ["tag,with,commas", "good"],
  });
});

test("identical timestamps and contents and delete-recreate cycles still produce distinct revisions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  const app = await fixture(t);
  const first = await register(app, definition());
  const second = await app.inject({ method: "PUT", url: "/api/targets/docs", payload: definition() });
  assert.equal(second.json().updatedAt, first.json().updatedAt);
  assert.notEqual(second.headers.etag, first.headers.etag);
  await app.inject({ method: "DELETE", url: "/api/targets/docs" });
  const recreated = await register(app, definition());
  assert.equal(recreated.json().createdAt, first.json().createdAt);
  assert.notEqual(recreated.headers.etag, first.headers.etag);
  assert.equal((await app.inject({
    method: "DELETE", url: "/api/targets/docs", headers: { "if-match": first.headers.etag },
  })).statusCode, 412);
});

test("database migration preserves definitions, timestamps, and persistent revisions", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "legacy.sqlite");
  const target = legacyDatabase(path);
  const first = new TargetStore(path);
  const current = first.getVersioned("legacy");
  assert.deepEqual(current.target, {
    ...target, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.match(current.etag, /^"[0-9a-f-]+"$/);
  first.close();
  const second = new TargetStore(path);
  assert.deepEqual(second.getVersioned("legacy"), current);
  second.close();
  const database = new DatabaseSync(path);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
  database.close();
});

test("migration failures roll back added columns and schema versions", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "blocked.sqlite");
  legacyDatabase(path, true);
  assert.throws(() => new TargetStore(path), /blocked migration/);
  const database = new DatabaseSync(path);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(database.prepare("PRAGMA table_info(targets)").all().some((column) => column.name === "revision"), false);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'block_migration'").get().name, "block_migration");
  database.exec("DROP TRIGGER block_migration");
  database.close();
  const recovered = new TargetStore(path);
  assert.ok(recovered.getVersioned("legacy").etag);
  recovered.close();
});

test("concurrent conditional updates through separate SQLite connections have one winner", { timeout: 15000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "concurrent.sqlite");
  const store = new TargetStore(path);
  const target = targetDefinitionSchema.parse(definition());
  const first = store.createVersioned(target);
  store.close();
  const workers = ["first", "second"].map((name) => new Worker(new URL("./version-worker.mjs", import.meta.url), {
    workerData: { path, etag: first.etag, definition: target, name },
  }));
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  await Promise.all(workers.map((worker) => once(worker, "message")));
  const results = workers.map((worker) => once(worker, "message"));
  const exits = workers.map((worker) => once(worker, "exit"));
  workers.forEach((worker) => worker.postMessage("start"));
  const messages = (await Promise.all(results)).map(([result]) => result);
  await Promise.all(exits);
  assert.deepEqual(messages.map((result) => result.status).sort(), [200, 412]);
  const reopened = new TargetStore(path);
  const saved = reopened.getVersioned("docs");
  reopened.close();
  assert.equal(saved.target.name, messages.find((result) => result.status === 200).name);
});

test("the CLI displays versions and reports conditional update and deletion conflicts", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition());
  const versioned = JSON.parse((await cli(["target", "get", "docs", "--hub", hub, "--with-version"])).stdout);
  assert.equal(versioned.target.id, "docs");
  assert.ok(versioned.etag);
  const directory = await temporaryDirectory(t);
  const file = join(directory, "update.json");
  await writeFile(file, JSON.stringify(definition("docs", { name: "Updated by CLI" })));
  const updated = JSON.parse((await cli([
    "target", "update", "docs", file, "--hub", hub, "--if-match", versioned.etag,
  ])).stdout);
  assert.equal(updated.name, "Updated by CLI");
  await assert.rejects(cli([
    "target", "remove", "docs", "--hub", hub, "--if-match", versioned.etag,
  ]), /412/);
  const current = await new HubClient(hub).getVersioned("docs");
  await cli(["target", "remove", "docs", "--hub", hub, "--if-match", current.etag]);
  assert.equal((await app.inject("/api/targets/docs")).statusCode, 404);
});

test("CLI refresh does not overwrite writes made after its final registry read", async (t) => {
  const source = await mcpSource(t);
  source.state.pages = [{ tools: [{ name: "new_remote_tool", inputSchema: { type: "object" } }] }];
  const app = createApp({ logger: false });
  let hub;
  let changed = false;
  const target = definition("docs", { connection: { transport: "streamable-http", url: source.url + "/mcp" } });
  app.addHook("preHandler", async (request) => {
    if (!changed && request.method === "PUT" && request.headers["if-match"]) {
      changed = true;
      await new HubClient(hub).update("docs", targetDefinitionSchema.parse({
        ...target, name: "Concurrent administrator",
      }));
    }
  });
  hub = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });
  await register(app, target);
  await assert.rejects(cli(["target", "refresh", "docs", "--hub", hub]), /412/);
  assert.equal(changed, true);
  const current = await new HubClient(hub).get("docs");
  assert.equal(current.name, "Concurrent administrator");
  assert.equal(current.capabilities[0].name, "search_docs");
  assert.equal(source.state.calls, 0);
});

test("bulk replacements change revisions while previews preserve them", async (t) => {
  const app = await fixture(t);
  const first = (await register(app, definition())).headers.etag;
  const data = {
    format: "agent-tcdh", version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    targets: [definition("docs", { name: "Restored" })],
  };
  const preview = await app.inject({
    method: "POST", url: "/api/registry/import?onConflict=replace&dryRun=true", payload: data,
  });
  assert.equal(preview.statusCode, 200);
  assert.equal((await app.inject("/api/targets/docs")).headers.etag, first);
  await app.inject({ method: "POST", url: "/api/registry/import?onConflict=replace", payload: data });
  assert.notEqual((await app.inject("/api/targets/docs")).headers.etag, first);
  assert.equal((await app.inject({
    method: "DELETE", url: "/api/targets/docs", headers: { "if-match": first },
  })).statusCode, 412);
});

test("OpenAPI describes version headers and conditional write 412 responses", async (t) => {
  const app = await fixture(t);
  const spec = (await app.inject("/openapi.json")).json();
  assert.ok(spec.paths["/api/targets"].post.responses["201"].headers.ETag);
  assert.ok(spec.paths["/api/targets/{id}"].get.responses["200"].headers.ETag);
  for (const method of ["put", "delete"]) {
    assert.ok(spec.paths["/api/targets/{id}"][method].parameters.some((parameter) => parameter.name === "If-Match"));
    assert.ok(spec.paths["/api/targets/{id}"][method].responses["412"]);
  }
});
