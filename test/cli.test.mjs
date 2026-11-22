// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { definition, fixture, temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");

/** Run the CLI in a child process and check for non-JSON output. */
async function cli(args, token = "") {
  return execute(process.execPath, [entry, ...args], {
    env: { ...process.env, AGENT_TCDH_TOKEN: token },
    timeout: 15_000,
  });
}

test("help and invalid commands or options are handled without network requests", async () => {
  assert.match((await cli(["--help"])).stdout, /AgentTCDH/);
  await assert.rejects(cli(["unknown"]), /Unknown command/);
  await assert.rejects(cli(["target", "get"]), /argument count/);
  await assert.rejects(cli(["target", "get", "docs", "--select", "other"]), /argument count/);
  await assert.rejects(cli(["target", "get", "--select", "docs", "--with-version"]), /Unsupported options/);
  await assert.rejects(cli(["target", "get", "--select", "docs", "--select", "docs"]), /unique/);
  await assert.rejects(cli(["target", "list", "--port", "3000"]), /Unsupported options/);
  await assert.rejects(cli(["serve", "--port", "0"]), /too_small/);
});

test("the CLI registers, searches, updates, and deletes definitions through HTTP", async (t) => {
  const directory = await temporaryDirectory(t);
  const app = await fixture(t, { token: "cli-secret" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const path = join(directory, "target.json");
  await writeFile(path, JSON.stringify(definition()));

  const added = JSON.parse((await cli(["target", "add", path, "--hub", hub], "cli-secret")).stdout);
  assert.equal(added.id, "docs");
  const listed = JSON.parse((await cli([
    "target", "list", "--hub", hub, "--q", "배포", "--protocol", "mcp", "--tag", "docs",
  ], "cli-secret")).stdout);
  assert.equal(listed.total, 1);
  assert.equal(JSON.parse((await cli(["target", "get", "docs", "--hub", hub], "cli-secret")).stdout).name, "Documentation");

  await writeFile(path, JSON.stringify(definition("docs", { enabled: false })));
  const updated = JSON.parse((await cli(["target", "update", "docs", path, "--hub", hub], "cli-secret")).stdout);
  assert.equal(updated.enabled, false);
  assert.equal(JSON.parse((await cli(["target", "list", "--hub", hub], "cli-secret")).stdout).total, 0);
  assert.equal(JSON.parse((await cli([
    "target", "list", "--include-disabled", "--hub", hub,
  ], "cli-secret")).stdout).total, 1);

  await assert.rejects(cli(["target", "get", "docs", "--hub", hub]), /401/);
  const removed = JSON.parse((await cli(["target", "remove", "docs", "--hub", hub], "cli-secret")).stdout);
  assert.deepEqual(removed, { deleted: "docs" });
  await assert.rejects(cli(["target", "get", "docs", "--hub", hub], "cli-secret"), /404/);
});

test("invalid JSON and mismatched ids are rejected before hub requests", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "invalid.json");
  await writeFile(path, "{");
  await assert.rejects(cli(["target", "add", path]));
  await writeFile(path, JSON.stringify(definition("other")));
  await assert.rejects(cli(["target", "update", "docs", path]), /same target id/);
  await assert.rejects(cli(["target", "list", "--limit", "0"]), /too_small/);
});
