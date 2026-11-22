import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";
import { fixture, register, definition, temporaryDirectory } from "./helpers.mjs";
import { mcpSource, cardSource } from "./import-helpers.mjs";
import { createDemoTargets } from "../examples/demo-targets.mjs";
import { availablePort, waitForHub } from "../scripts/smoke-runtime.mjs";
import { mergeConnection, connectClient } from "../dist/onboarding/connect.js";
import { writeConfigText, readConfigText } from "../dist/onboarding/files.js";
import { diagnose } from "../dist/onboarding/doctor.js";
import { loadConfig, consumerTokenEnv } from "../dist/onboarding/config.js";
import { targetTable } from "../dist/onboarding/output.js";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");

/** Run the CLI without inheriting contributor credentials or personal setup state. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "", AGENT_TCDH_URL: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  return execute(process.execPath, [entry, ...args], { env: { ...env, ...environment }, timeout: 25_000 });
}

/** Capture a known CLI failure without turning an unexpected success into a passing assertion. */
async function failure(args, environment = {}) {
  try {
    await cli(args, environment);
  } catch (error) {
    return error;
  }
  assert.fail("The CLI command must fail.");
}

test("setup is non-interactive only with --yes and never stores credential values", async (t) => {
  const directory = await temporaryDirectory(t);
  const config = join(directory, "setup with spaces.json");
  const error = await failure(["init", "--config", config]);
  assert.match(error.stderr, /Use init --yes/);
  assert.equal(await readConfigText(config), undefined);
  const result = JSON.parse((await cli(["init", "--yes", "--config", config, "--port", "3234", "--db", "data/registry.sqlite",
    "--token-env", "SETUP_ADMIN", "--read-token-env", "SETUP_READER"], { SETUP_ADMIN: "never-print-this-token" })).stdout);
  assert.equal(result.hub, "http://127.0.0.1:3234");
  const content = await readFile(config, "utf8");
  assert.equal(content.includes("never-print-this-token"), false);
  assert.equal(JSON.stringify(result).includes("never-print-this-token"), false);
  const saved = JSON.parse(content);
  assert.equal(saved.tokenEnv, "SETUP_ADMIN");
  assert.equal(saved.server.dbPath, join(directory, "data", "registry.sqlite"));
  if (process.platform !== "win32") {
    assert.equal((await stat(config)).mode & 0o777, 0o600);
  }
  const duplicate = await failure(["init", "--yes", "--config", config]);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(await readFile(config, "utf8"), content);
  const replaced = JSON.parse((await cli(["init", "--yes", "--force", "--config", config, "--port", "3235"])).stdout);
  assert.equal(await readFile(replaced.backup, "utf8"), content);
  assert.equal(JSON.parse(await readFile(config, "utf8")).server.port, 3235);
});

test("invalid setup and explicitly missing configurations fail without partial files", async (t) => {
  const path = join(await temporaryDirectory(t), "config.json");
  assert.match((await failure(["init", "--yes", "--config", path, "--hub", "https://user:secret@example.test"])).stderr, /without credentials/);
  assert.equal(await readConfigText(path), undefined);
  assert.match((await failure(["init", "--yes", "--config", path, "--port", "0"])).stderr, /too_small/);
  assert.equal(await readConfigText(path), undefined);
  assert.match((await failure(["connect", "codex", "--config", path])).stderr, /not found/);
  await writeFile(path, '{"token":"do-not-echo"}');
  const invalid = await failure(["doctor", "--config", path]);
  assert.match(invalid.stderr, /Invalid AgentTCDH configuration/);
  assert.equal(invalid.stderr.includes("do-not-echo"), false);
});

test("setup defaults are consumed by serve, with read credentials usable by doctor", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "setup.json");
  const port = await availablePort();
  await cli(["init", "--yes", "--config", path, "--port", String(port), "--db", "registry.sqlite",
    "--token-env", "SETUP_ADMIN", "--read-token-env", "SETUP_READER"]);
  const environment = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "",
    SETUP_ADMIN: "setup-admin-value", SETUP_READER: "setup-reader-value" };
  for (const variable of ["HOST", "PORT", "AGENT_TCDH_DB_PATH"]) {
    delete environment[variable];
  }
  const child = spawn(process.execPath, [entry, "serve", "--config", path], { env: environment, stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  await waitForHub("http://127.0.0.1:" + port, () => child.exitCode === null && child.signalCode === null);
  const doctor = JSON.parse((await cli(["doctor", "--config", path], { SETUP_READER: "setup-reader-value" })).stdout);
  assert.equal(doctor.status, "passed");
  assert.equal(doctor.executionVerified, false);
  assert.ok(doctor.checks.some((check) => check.id === "discovery" && check.status === "passed"));
  const connect = parseToml((await cli(["connect", "codex", "--config", path, "--print"])).stdout);
  assert.equal(connect.mcp_servers.agent_tcdh.bearer_token_env_var, "SETUP_READER");
  assert.ok((await stat(join(directory, "registry.sqlite"))).isFile());
});

test("CLI and environment URLs override configured defaults and credential selection is explicit", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const path = join(await temporaryDirectory(t), "setup.json");
  await cli(["init", "--yes", "--config", path, "--hub", "http://127.0.0.1:1"]);
  assert.equal(JSON.parse((await cli(["target", "list", "--config", path], { AGENT_TCDH_URL: hub })).stdout).total, 0);
  assert.equal(JSON.parse((await cli(["target", "list", "--config", path, "--hub", hub], { AGENT_TCDH_URL: "http://127.0.0.1:1" })).stdout).total, 0);
  assert.equal(consumerTokenEnv({ tokenEnv: "ADMIN", readTokenEnv: "READ" }, {}), "READ");
  assert.equal(consumerTokenEnv(undefined, { AGENT_TCDH_READ_TOKEN: "secret" }), "AGENT_TCDH_READ_TOKEN");
  assert.equal((await loadConfig(path)).hub, "http://127.0.0.1:1");
});

test("remote read-only setup reuses a hub without starting a local server or requiring admin secrets", async (t) => {
  const app = await fixture(t, { token: "remote-admin", readToken: "remote-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const directory = await temporaryDirectory(t);
  const path = join(directory, "remote.json");
  const initialized = JSON.parse((await cli(["init", "--yes", "--remote", "--hub", hub, "--read-token-env", "REMOTE_READ", "--config", path])).stdout);
  assert.equal(initialized.mode, "remote");
  assert.equal(initialized.nextCommands.some((args) => args.includes("serve")), false);
  assert.equal(JSON.parse((await cli(["target", "list", "--config", path], { REMOTE_READ: "remote-reader" })).stdout).total, 0);
  assert.equal(JSON.parse((await cli(["doctor", "--config", path], { REMOTE_READ: "remote-reader" })).stdout).status, "passed");
  assert.match((await failure(["serve", "--config", path])).stderr, /existing hub/);
  assert.match((await failure(["target", "add", "--command", process.execPath, "--config", path])).stderr, /administrator credential/);
  const preview = JSON.parse((await cli(["target", "add", "--command", process.execPath, "--config", path, "--dry-run"])).stdout);
  assert.equal(preview.connection.transport, "stdio");
  const missing = join(directory, "missing-hub.json");
  assert.match((await failure(["init", "--remote", "--yes", "--config", missing])).stderr, /requires --hub/);
  assert.equal(await readConfigText(missing), undefined);
});

test("connection fragments use documented Codex and explicit OpenCode v1/v2 layouts", () => {
  const codex = parseToml(mergeConnection("codex", "https://hub.example/base/", "HUB_READ").content);
  assert.deepEqual({ ...codex.mcp_servers.agent_tcdh }, { url: "https://hub.example/base/mcp", bearer_token_env_var: "HUB_READ" });
  const v2 = JSON.parse(mergeConnection("opencode", "https://hub.example", "HUB_READ").content);
  assert.equal(v2.mcp.servers.agent_tcdh.headers.Authorization, "Bearer {env:HUB_READ}");
  assert.equal(v2.mcp.servers.agent_tcdh.oauth, false);
  const v1 = JSON.parse(mergeConnection("opencode-v1", "https://hub.example").content);
  assert.equal(v1.mcp.agent_tcdh.url, "https://hub.example/mcp");
  assert.equal(v1.mcp.agent_tcdh.headers, undefined);
  assert.throws(() => mergeConnection("opencode", "https://hub.example", undefined, JSON.stringify(v1)), /v1 server layout/);
  assert.throws(() => mergeConnection("opencode-v1", "https://hub.example", undefined, JSON.stringify(v2)), /v2 server layout/);
  const v1ReservedName = mergeConnection("opencode-v1", "https://hub.example", undefined, "", false, "servers").content;
  assert.equal(JSON.parse(mergeConnection("opencode-v1", "https://hub.example", undefined, v1ReservedName, false, "servers").content).mcp.servers.type, "remote");
});

test("Codex merges preserve existing text, reject collisions, and support idempotent managed updates", () => {
  const original = '# Keep this comment\nmodel = "existing-model"\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n';
  const first = mergeConnection("codex", "https://hub.example", undefined, original).content;
  assert.ok(first.startsWith(original));
  assert.equal(parseToml(first).mcp_servers.other.url, "https://other.example/mcp");
  assert.equal(mergeConnection("codex", "https://hub.example", undefined, first).content, first);
  assert.throws(() => mergeConnection("codex", "https://changed.example", undefined, first), /--replace/);
  const updated = mergeConnection("codex", "https://changed.example", "READ", first, true).content;
  assert.ok(updated.startsWith(original));
  assert.equal(parseToml(updated).mcp_servers.agent_tcdh.url, "https://changed.example/mcp");
  const inline = 'mcp_servers = { other = { url = "https://other.example" } }\n';
  assert.throws(() => mergeConnection("codex", "https://hub.example", undefined, inline), /normalization/);
  const normalized = mergeConnection("codex", "https://hub.example", undefined, inline, true);
  assert.equal(parseToml(normalized.content).mcp_servers.other.url, "https://other.example");
  assert.equal(normalized.notes.length, 1);
});

test("explicit client writes preserve JSONC comments and exact backups without echoing unrelated secrets", async (t) => {
  const path = join(await temporaryDirectory(t), "opencode.jsonc");
  const original = '{\n  // preserve this comment\n  "model": "existing", "apiKey": "private-unrelated-value",\n  "mcp": { "servers": { "other": { "type": "remote", "url": "https://other.example" } } },\n}\n';
  await writeFile(path, original);
  const args = ["connect", "opencode", "--hub", "https://hub.example", "--token-env", "HUB_READER", "--write", path];
  const preview = JSON.parse((await cli([...args, "--dry-run"])).stdout);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(JSON.stringify(preview).includes("private-unrelated-value"), false);
  const result = JSON.parse((await cli(args)).stdout);
  assert.equal(result.changed, true);
  assert.equal(result.content, undefined);
  assert.equal(JSON.stringify(result).includes("private-unrelated-value"), false);
  assert.equal(await readFile(result.backup, "utf8"), original);
  const content = await readFile(path, "utf8");
  assert.ok(content.includes("// preserve this comment"));
  assert.equal(parseJsonc(content).apiKey, "private-unrelated-value");
  assert.equal(parseJsonc(content).mcp.servers.other.url, "https://other.example");
  assert.equal(JSON.parse((await cli(args)).stdout).changed, false);
  assert.match((await failure(["connect", "opencode", "--hub", "https://changed.example", "--write", path])).stderr, /--replace/);
  assert.equal(await readFile(path, "utf8"), content);
});

test("unsafe or malformed client files and concurrent changes are preserved", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "config.toml");
  await writeFile(path, 'api_key = "secret-marker');
  const invalid = await failure(["connect", "codex", "--write", path]);
  assert.match(invalid.stderr, /Invalid TOML/);
  assert.equal(invalid.stderr.includes("secret-marker"), false);
  assert.equal(await readFile(path, "utf8"), 'api_key = "secret-marker');
  await writeFile(path, "changed");
  await assert.rejects(writeConfigText(path, "replacement", "old"), /changed since/);
  assert.equal(await readFile(path, "utf8"), "changed");
  const linked = join(directory, "linked.toml");
  try {
    await symlink(path, linked);
    await assert.rejects(connectClient({ client: "codex", hub: "https://hub.example", write: linked }), /regular file/);
  } catch (error) {
    if (error.code !== "EPERM" || process.platform !== "win32") {
      throw error;
    }
  }
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x7b]));
  await assert.rejects(readConfigText(path), /valid UTF-8/);
  await writeFile(path, "x".repeat(1_048_577));
  await assert.rejects(readConfigText(path), /1 MiB/);
});

test("remote quick add detects MCP metadata, derives stable ids, and honors dry-run", async (t) => {
  const source = await mcpSource(t);
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const args = ["target", "add", source.url + "/mcp", "--hub", hub];
  const preview = JSON.parse((await cli([...args, "--dry-run"])).stdout);
  assert.equal(preview.protocol, "mcp");
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  const target = JSON.parse((await cli(args)).stdout);
  assert.equal(target.id, preview.id);
  assert.equal(target.capabilities[0].name, "search_docs");
  assert.equal(source.state.calls, 0);
});

test("remote quick add discovers A2A and rejects ambiguous protocols without registration", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await cardSource(t, async () => ({ name: "Peer", description: "A metadata-only peer", url: "https://peer.example/a2a", skills: [] }));
  const added = JSON.parse((await cli(["target", "add", source.url, "--hub", hub])).stdout);
  assert.equal(added.protocol, "a2a");
  const dual = await createDemoTargets();
  t.after(() => dual.app.close());
  const error = await failure(["target", "add", dual.url + "/mcp", "--hub", hub]);
  assert.match(error.stderr, /Both MCP and A2A/);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
  const explicit = JSON.parse((await cli(["target", "add", dual.url + "/mcp", "--protocol", "mcp", "--hub", hub])).stdout);
  assert.equal(explicit.protocol, "mcp");
  assert.equal(dual.executions.length, 0);
});

test("stdio quick registration and doctor never execute the registered command", async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = join(directory, "must-not-exist");
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const args = ["target", "add", "--command", process.execPath, "--arg=-e",
    "--arg=" + "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')", "--env-var", "TARGET_SECRET",
    "--name", "Local fixture", "--hub", hub];
  const target = JSON.parse((await cli(args)).stdout);
  const error = await failure(["doctor", "--hub", hub, "--target", target.id]);
  const missing = JSON.parse(error.stdout);
  assert.equal(missing.status, "failed");
  assert.ok(missing.checks.some((check) => check.id === "target-env:TARGET_SECRET" && check.status === "failed"));
  const report = JSON.parse((await cli(["doctor", "--hub", hub, "--target", target.id], { TARGET_SECRET: "never-print-secret" })).stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.target.status, "skipped");
  assert.equal(report.executionVerified, false);
  assert.equal(JSON.stringify(report).includes("never-print-secret"), false);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("doctor separates health, authentication, metadata, and execution verification", async (t) => {
  const app = await fixture(t, { token: "doctor-admin", readToken: "doctor-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const missing = await diagnose({ hub, tokenEnv: "SELECTED" }, {});
  assert.equal(missing.status, "failed");
  assert.ok(missing.checks.some((check) => check.id === "hub" && check.status === "passed"));
  assert.ok(missing.checks.some((check) => check.id === "discovery" && check.status === "skipped"));
  const wrong = await diagnose({ hub, tokenEnv: "SELECTED" }, { SELECTED: "wrong-value" });
  assert.ok(wrong.checks.some((check) => check.id === "discovery" && check.status === "failed"));
  assert.equal(JSON.stringify(wrong).includes("wrong-value"), false);
  const source = await mcpSource(t);
  await register(app, definition("remote", { connection: { transport: "streamable-http", url: source.url + "/mcp" } }), { Authorization: "Bearer doctor-admin" });
  const good = await diagnose({ hub, tokenEnv: "SELECTED", target: "remote" }, { SELECTED: "doctor-reader" });
  assert.equal(good.target.scope, "mcp-tools-list");
  assert.equal(good.executionVerified, false);
  assert.equal(good.target.executionVerified, false);
  assert.equal(source.state.calls, 0);
});

test("terminal tables strip controls while JSON and fragment modes remain explicit", async () => {
  const text = targetTable({ items: [{ ...definition("docs\u001b[31m"), enabled: true }], total: 1, limit: 20, offset: 0 });
  assert.ok(text.includes("docs"));
  assert.equal(text.includes("\u001b"), false);
  const summary = targetTable({ view: "summary", total: 1, limit: 20, offset: 0, items: [{ id: "docs", protocol: "mcp", enabled: true,
    transport: "streamable-http", authType: "bearer",
    capabilityCount: 2, matchedCapabilities: [{ name: "search\u001b[31m", description: "Search documentation" }] }] });
  assert.match(summary, /MATCHED CAPABILITIES/);
  assert.match(summary, /streamable-http\s+bearer/);
  assert.match(summary, /search/);
  assert.equal(summary.includes("\u001b"), false);
  const empty = { items: [], total: 0, limit: 20, offset: 0 };
  assert.equal(targetTable(empty), "0 matching targets.\n");
  const suggestions = targetTable({ ...empty, suggestions: [{ id: "docs", name: "Search docs", protocol: "mcp", transport: "streamable-http",
    enabled: true, description: "", capabilityCount: 1, matchedCapabilities: [], missingTerm: "archive\u001b[31m" }] });
  assert.match(suggestions, /Suggestions missing one search term/);
  assert.match(suggestions, /docs\s+Search docs\s+Missing "archive/);
  assert.equal(suggestions.includes("\u001b"), false);
  assert.match((await failure(["connect", "codex", "--print", "--json"])).stderr, /cannot be combined/);
  assert.match((await failure(["connect", "codex", "--dry-run"])).stderr, /--write FILE/);
});
