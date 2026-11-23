import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prepareConfigImport } from "../dist/onboarding/import-config.js";
import { mergeConnection } from "../dist/onboarding/connect.js";
import { fixture, definition, register, temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const executable = resolve("dist/index.js");
const profiles = ["claude-code", "gemini-cli", "cursor", "vscode"];

/** Generate settings without inheriting personal setup or contributor credentials. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  return execute(process.execPath, [executable, ...args], { env: { ...env, ...environment }, timeout: 20_000 });
}

/** Capture expected validation failures without accepting an unexpected success. */
async function failure(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  assert.fail("The command must fail.");
}

/** Read the generated named entry from its documented client-specific container. */
function serverEntry(profile, content, name = "agent_tcdh") {
  const root = JSON.parse(content);
  return (profile === "vscode" ? root.servers : root.mcpServers)[name];
}

test("new client profiles use documented containers and variable references with an isolated local bridge", () => {
  for (const profile of profiles) {
    const entry = serverEntry(profile, mergeConnection(profile, "https://hub.example/base/", "HUB_READER").content);
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [executable, "mcp", "--hub", "https://hub.example/base", "--no-config", "--token-env", "HUB_READER"]);
    assert.deepEqual(entry.env, { HUB_READER: ["cursor", "vscode"].includes(profile) ? "${env:HUB_READER}" : "${HUB_READER}" });
    assert.equal(entry.type, profile === "gemini-cli" ? undefined : "stdio");
    assert.equal(entry.trust, undefined);
    const anonymous = serverEntry(profile, mergeConnection(profile, "http://127.0.0.1:3000").content);
    assert.equal(anonymous.env, undefined);
    assert.ok(anonymous.args.includes("--anonymous"));
    assert.equal(anonymous.args.includes("--token-env"), false);
    const reserved = serverEntry(profile, mergeConnection(profile, "http://127.0.0.1:3000", undefined, "", false, "constructor").content, "constructor");
    assert.equal(reserved.command, process.execPath);
  }
});

test("client JSONC merges preserve BOM, unrelated settings, comments, backups, and idempotence", async (t) => {
  for (const profile of profiles) {
    const path = join(await temporaryDirectory(t), "client with spaces.jsonc");
    const root = profile === "vscode" ? "servers" : "mcpServers";
    const original = '\uFEFF{\n // keep this comment\n "model": "existing", "apiKey": "private-unrelated-value",\n "' + root + '": {"other": {"command":"existing"}},\n}\n';
    await writeFile(path, original);
    const args = ["connect", profile, "--hub", "https://hub.example", "--token-env", "HUB_READER", "--write", path];
    const preview = JSON.parse((await cli([...args, "--dry-run"], { HUB_READER: "private-token-value" })).stdout);
    assert.equal(preview.transport, "stdio");
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(JSON.stringify(preview).includes("private-unrelated-value"), false);
    assert.equal(JSON.stringify(preview).includes("private-token-value"), false);
    const applied = JSON.parse((await cli(args)).stdout);
    assert.equal(await readFile(applied.backup, "utf8"), original);
    const content = await readFile(path, "utf8");
    assert.ok(content.startsWith("\uFEFF"));
    assert.ok(content.includes("// keep this comment"));
    assert.equal(parseJsonc(content.slice(1))[root].other.command, "existing");
    assert.equal(JSON.parse((await cli(args)).stdout).changed, false);
    assert.match((await failure(["connect", profile, "--hub", "https://changed.example", "--write", path])).stderr, /--replace/);
    assert.equal(await readFile(path, "utf8"), content);
    const replaced = JSON.parse((await cli(["connect", profile, "--hub", "https://changed.example", "--write", path, "--replace"])).stdout);
    assert.equal(await readFile(replaced.backup, "utf8"), content);
    assert.ok(parseJsonc((await readFile(path, "utf8")).slice(1))[root].agent_tcdh.args.includes("https://changed.example"));
  }
});

test("client profile validation rejects malformed or conflicting containers without printing source values", () => {
  assert.throws(() => mergeConnection("vscode", "http://localhost", undefined, '{"mcpServers":{}}'), /different MCP server container/);
  assert.throws(() => mergeConnection("cursor", "http://localhost", undefined, '{"servers":{}}'), /different MCP server container/);
  for (const profile of profiles) {
    const key = profile === "vscode" ? "servers" : "mcpServers";
    assert.throws(() => mergeConnection(profile, "http://localhost", undefined, '{"' + key + '":[]}'), /must be an object/);
    assert.throws(() => mergeConnection(profile, "http://localhost", undefined, '{"token":"private-source-value"'), /Invalid JSON/);
    assert.throws(() => mergeConnection(profile, "http://user:private-password@localhost"), /without credentials/);
  }
});

for (const profile of profiles) {
  test(profile + " generated settings launch authenticated live discovery through the SDK from a different directory", async (t) => {
    const app = await fixture(t, { token: "client-admin", readToken: "client-reader" });
    const hub = await app.listen({ host: "127.0.0.1", port: 0 });
    await register(app, definition("first"), { Authorization: "Bearer client-admin" });
    const directory = await temporaryDirectory(t);
    const generated = await cli(["connect", profile, "--hub", hub, "--token-env", "CLIENT_READER", "--print"], { CLIENT_READER: "must-not-read-during-generation" });
    assert.equal(generated.stdout.includes("must-not-read-during-generation"), false);
    const settings = serverEntry(profile, generated.stdout);
    // Supply the selected fixture credential after asserting the client's placeholder syntax separately.
    const transport = new StdioClientTransport({ command: settings.command, args: settings.args, cwd: directory,
      env: { CLIENT_READER: "client-reader", AGENT_TCDH_CONFIG: join(directory, "missing-personal-config.json"),
        AGENT_TCDH_TOKEN: "invalid inherited administrator credential", AGENT_TCDH_URL: "http://127.0.0.1:1" }, stderr: "pipe" });
    const client = new Client({ name: "generated-profile-test", version: "1.0.0" });
    t.after(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["get_target", "get_targets", "search_targets"]);
    const first = await client.callTool({ name: "get_target", arguments: { id: "first" } });
    assert.equal(first.isError, undefined);
    assert.equal(JSON.parse(first.content[0].text).id, "first");
    await register(app, definition("second"), { Authorization: "Bearer client-admin" });
    const found = await client.callTool({ name: "search_targets", arguments: {} });
    assert.equal(JSON.parse(found.content[0].text).total, 2);
    await app.inject({ method: "DELETE", url: "/api/targets/first", headers: { Authorization: "Bearer client-admin" } });
    const removed = await client.callTool({ name: "get_target", arguments: { id: "first" } });
    assert.equal(removed.isError, true);
  });
}

for (const [profile, layout] of [["codex", "mcp_servers"], ["opencode-v1", "mcp"], ["opencode", "mcp.servers"]]) {
  test(profile + " versioned HTTP layout authenticates and returns a first summary search through the SDK", async (t) => {
    const app = await fixture(t, { token: "layout-admin", readToken: "layout-reader" });
    const hub = await app.listen({ host: "127.0.0.1", port: 0 });
    assert.equal((await register(app, definition("first"), { authorization: "Bearer layout-admin" })).statusCode, 201);
    const { stdout } = await cli(["connect", profile, "--hub", hub, "--token-env", "LAYOUT_READER", "--print"]);
    const config = profile === "codex" ? parseToml(stdout) : parseJsonc(stdout);
    const entry = layout.split(".").reduce((value, segment) => value[segment], config).agent_tcdh;
    const bearer = profile === "codex" ? entry.bearer_token_env_var : entry.headers.Authorization.match(/^Bearer \{env:([A-Z_]+)\}$/u)?.[1];
    assert.equal(bearer, "LAYOUT_READER");
    assert.equal(entry.url, hub + "/mcp");
    if (profile !== "codex") {
      assert.equal(entry.type, "remote");
      assert.equal(entry.oauth, false);
    }
    const settings = { LAYOUT_READER: "layout-reader" };
    const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: { authorization: "Bearer " + settings[bearer] } },
    });
    const client = new Client({ name: "http-layout-test", version: "1.0.0" });
    t.after(() => client.close());
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), ["get_target", "get_targets", "search_targets"]);
    const search = await client.callTool({ name: "search_targets", arguments: { tag: "docs", view: "summary" } });
    assert.equal(search.isError, undefined);
    assert.deepEqual(JSON.parse(search.content[0].text).items.map(({ id }) => id), ["first"]);
  });
}

test("connect previews additions, no-ops, and redacted replacements without changing the file", async (t) => {
  const path = join(await temporaryDirectory(t), "client.jsonc");
  const args = ["connect", "opencode", "--hub", "https://hub.example", "--write", path];
  const preview = async () => JSON.parse((await cli([...args, "--plan"])).stdout);
  assert.equal((await preview()).plan.action, "add");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await cli(args);
  assert.equal((await preview()).plan.action, "unchanged");
  const original = '{"mcp":{"servers":{"agent_tcdh":{"type":"remote","url":"https://previous.example","headers":{"Authorization":"private-previous-value"},"private-setting":"private-setting-value"}}}}';
  await writeFile(path, original);
  const report = await preview();
  assert.equal(report.plan.action, "replace");
  assert.equal(report.plan.requiresReplace, true);
  assert.deepEqual(report.plan.differingFields, ["url", "headers", "oauth", "additional-settings"]);
  assert.doesNotMatch(JSON.stringify(report), /private-|previous\.example/u);
  assert.equal(await readFile(path, "utf8"), original);
});

test("anonymous bridge settings ignore inherited administrator credentials and personal setup", async (t) => {
  const app = await fixture(t, { token: "private-hub-admin" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const settings = serverEntry("cursor", mergeConnection("cursor", hub).content);
  const directory = await temporaryDirectory(t);
  const transport = new StdioClientTransport({ command: settings.command, args: settings.args, cwd: directory,
    env: { AGENT_TCDH_TOKEN: "private-hub-admin", AGENT_TCDH_CONFIG: join(directory, "missing.json") }, stderr: "pipe" });
  const client = new Client({ name: "anonymous-profile-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  const found = await client.callTool({ name: "search_targets", arguments: {} });
  assert.equal(found.isError, true);
  assert.match(found.content[0].text, /401/);
  assert.equal(JSON.stringify(found).includes("private-hub-admin"), false);
});

test("bridge-only options reject ambiguous authentication and unrelated commands", async () => {
  for (const args of [["mcp", "--anonymous", "--token-env", "READER"], ["mcp", "--no-config", "--config", "missing.json"],
    ["doctor", "--no-config"], ["serve", "--anonymous"], ["connect", "cursor", "--no-config"]]) {
    const error = await failure(args);
    assert.match(error.stderr, /mcp-only options/);
    assert.equal(error.stdout, "");
  }
});


test("client imports exclude this installation's destination bridge before parsing client-specific environment references", () => {
  for (const profile of ["claude-code", "gemini-cli", "cursor"]) {
    const hub = "https://hub.example";
    const root = JSON.parse(mergeConnection(profile, hub, "HUB_READER").content);
    root.mcpServers.local = { command: process.execPath };
    const report = prepareConfigImport(JSON.stringify(root), { hub });
    assert.equal(report.ready, true);
    assert.deepEqual(report.targets.map((target) => target.id), ["local"]);
    assert.ok(report.issues.some((issue) => issue.code === "HUB_SELF_REFERENCE"));
    root.mcpServers.agent_tcdh.args.push("--extra");
    const altered = prepareConfigImport(JSON.stringify(root), { hub });
    assert.equal(altered.issues.some((issue) => issue.code === "HUB_SELF_REFERENCE"), false);
  }
});
