import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { selectImportEntries } from "../dist/onboarding/import-select.js";
import { auditSummaryBatch } from "../scripts/selection-audit.mjs";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const executable = resolve("dist/index.js");
const cli = (args) => execute(process.execPath, [executable, ...args], { timeout: 15_000 });

test("search explains aliases, reports exclusions, and previews only required input names and types", async (t) => {
  const app = await fixture(t);
  const enabled = definition("first", { aliases: ["검색 bot"], capabilities: [{
    name: "lookup", description: "search deployment", inputSchema: { type: "object", required: ["query", "fallback"],
      properties: { query: { type: "string", default: "private-input-fixture" }, fallback: { type: ["string", "number"] } } },
  }] });
  assert.equal((await register(app, enabled)).statusCode, 201);
  assert.equal((await register(app, definition("disabled", { aliases: ["검색 bot"], enabled: false }))).statusCode, 201);
  const search = async (args) => (await app.inject({ method: "GET", url: "/api/targets", query: args })).json();
  const result = await search({ q: "검색 BOT", view: "summary", explain: "true", withFreshness: "true", inputs: "true" });
  assert.equal(result.total, 1);
  assert.deepEqual(result.explanations[0], { id: "first",
    terms: [{ term: "검색", fields: ["description", "alias"] }, { term: "bot", fields: ["alias"] }] });
  assert.deepEqual(result.freshness, [{ id: "first", state: "unknown", status: "unknown", checkedAt: null }]);
  assert.deepEqual((await search({ q: "lookup", view: "summary", inputs: "true" })).items[0].matchedCapabilities[0].requiredInputs,
    [{ name: "query", type: "string" }, { name: "fallback", type: null }]);
  assert.doesNotMatch(JSON.stringify(await search({ view: "summary", inputs: "true" })), /private-input-fixture/u);
  const excluded = await search({ q: "bot", tag: "unavailable", auth: "bearer", explain: "true" });
  assert.equal(excluded.total, 0);
  assert.deepEqual(excluded.exclusions, { disabled: 1, tag: 2, auth: 2 });
});

test("search cursors keep page order and reject mismatched options, observations, and cross-connection writes", async (t) => {
  const database = join(await temporaryDirectory(t), "registry.sqlite");
  const app = await fixture(t, { dbPath: database });
  const writer = await fixture(t, { dbPath: database });
  const first = await register(app, definition("first", { aliases: ["manual"] }));
  for (const id of ["second", "third"]) {
    assert.equal((await register(app, definition(id, { aliases: ["manual"] }))).statusCode, 201);
  }
  const page = (cursor, more = {}) => app.inject({ method: "GET", url: "/api/targets",
    query: { q: "manual", limit: "1", view: "summary", withFreshness: "true", cursor, ...more } });
  const head = (await page("start")).json();
  assert.equal(head.items[0].id, "first");
  const tail = (await page(head.nextCursor)).json();
  assert.equal(tail.items[0].id, "second");
  assert.equal((await page(tail.nextCursor)).json().nextCursor, null);
  assert.equal((await page(head.nextCursor, { limit: "2" })).json().error.code, "INVALID_SEARCH_CURSOR");
  const observed = await writer.inject({ method: "POST", url: "/api/targets/first/observation",
    headers: { "if-match": first.headers.etag }, payload: { status: "warning", scope: "metadata", executionVerified: false } });
  assert.equal(observed.statusCode, 200);
  assert.equal((await page(head.nextCursor)).json().error.code, "SEARCH_CURSOR_CHANGED");
  const current = (await page("start", { freshness: "fresh" })).json();
  assert.equal(current.total, 1);
  assert.equal(current.freshness[0].status, "warning");
  const restart = (await page("start")).json();
  await register(writer, definition("fourth", { aliases: ["manual"] }));
  assert.equal((await page(restart.nextCursor)).statusCode, 409);
});

test("search profiles keep only reusable options and support isolated previews and shell completions", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "search profiles.json");
  const save = ["search-profile", "save", "review", "--search-profiles-file", path, "--q", "manual", "--explain", "--inputs"];
  assert.equal(JSON.parse((await cli(save)).stdout).applied, false);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(JSON.parse((await cli([...save, "--apply"])).stdout).changed, true);
  await assert.rejects(cli([...save, "--apply"]), /--replace/u);
  const show = await cli(["search-profile", "show", "review", "--search-profiles-file", path]);
  assert.deepEqual(JSON.parse(show.stdout).options, { q: "manual", includeDisabled: false, limit: 20, explain: true, inputs: true });
  await assert.rejects(cli(["search-profile", "save", "wrong", "--search-profiles-file", path, "--cursor", "start"]), /Unsupported options/u);
  for (const shell of ["bash", "zsh", "powershell"]) {
    const generated = (await cli(["completion", shell])).stdout;
    assert.match(generated, /target list/u);
    assert.match(generated, /--search-profile/u);
    assert.match(generated, /--watch/u);
  }
});

test("summary batch audit rejects duplicate queries, wrong IDs, and per-target retrieval", () => {
  const search = { tool: "search_targets", search: { tag: "fixture", auth: "bearer", view: "summary", inputs: true } };
  const get = { tool: "get_targets", targetIds: ["second", "first"] };
  assert.equal(auditSummaryBatch([search, get], ["first", "second"], "fixture").hubBatchGetCalls, 1);
  assert.throws(() => auditSummaryBatch([search, search, get], ["first", "second"], "fixture"), /one summary search/u);
  const failed = {};
  assert.throws(() => auditSummaryBatch([search, get], ["first", "other"], "fixture", failed), /each selected ID/u);
  assert.deepEqual(failed.unrelatedLookupIds, ["second"]);
  assert.throws(() => auditSummaryBatch([search, get, { tool: "get_target", targetId: "first" }], ["first", "second"], "fixture"), /without individual lookups/u);
});

test("interactive target selection caps the batch and returns selected IDs in displayed order", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = (value) => { input.isRaw = value; };
  const choices = ["first", "second", "third"].map((key) => ({ key, protocol: "mcp", name: key, status: "enabled" }));
  const pending = selectImportEntries(choices, input, output, { limit: 2 });
  for (const name of ["down", "space", "up", "space", "up", "space", "return"]) {
    input.emit("keypress", "", { name });
  }
  assert.deepEqual(await pending, ["first", "second"]);
  assert.equal(input.isRaw, false);
});
