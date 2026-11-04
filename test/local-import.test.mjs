import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { prepareLocalImport } from "../dist/onboarding/local-import.js";
import { localSourceLocations } from "../dist/onboarding/local-sources.js";
import { localAgents } from "../dist/onboarding/local-a2a.js";
import { fixture, temporaryDirectory } from "./helpers.mjs";
import { cardSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const remote = (url = "https://docs.example/mcp") => ({ type: "http", url });
const card = { name: "Peer", description: "Remote peer", protocolVersion: "0.3.0", preferredTransport: "JSONRPC",
  url: "https://peer.example/tasks", skills: [{ id: "research", name: "Research", description: "Research metadata" }] };

/** Create isolated user and project roots without changing HOME or any contributor configuration. */
async function roots(t) {
  const root = await temporaryDirectory(t);
  return { home: join(root, "home"), project: join(root, "project") };
}

/** Write a fixture source and preserve its exact text for later non-modification checks. */
async function source(path, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return text;
}

/** Invoke the CLI against explicitly isolated source roots and preserve diagnostic exit codes. */
async function cli(options, args = [], environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  try {
    return { ...(await execute(process.execPath, [resolve("dist/index.js"), "registry", "import-local",
      "--home", options.home, "--project", options.project, ...args], { env: { ...env, ...environment }, timeout: 30_000 })), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return error;
  }
}

test("local sources cover six clients and native editor paths while explicit homes isolate path overrides", async (t) => {
  const options = await roots(t);
  const environment = { CODEX_HOME: "/unrelated-codex", XDG_CONFIG_HOME: "/unrelated-config", APPDATA: "/unrelated-appdata", OPENCODE_CONFIG: "/unrelated.json" };
  const locations = localSourceLocations(options, environment);
  assert.equal(new Set(locations.sources.map((item) => item.client)).size, 6);
  assert.ok(locations.sources.every((item) => item.path.startsWith(options.home) || item.path.startsWith(options.project)));
  assert.equal(locations.sources.some((item) => item.id.endsWith("custom")), false);
  const user = localSourceLocations({ ...options, scope: "user", clients: ["codex"] });
  assert.equal(user.sources.length, 1);
  assert.equal(user.sources[0].path, join(options.home, ".codex", "config.toml"));
  const mac = localSourceLocations({ ...options, clients: ["vscode"] }, {}, "darwin");
  const win = localSourceLocations({ ...options, clients: ["vscode"] }, {}, "win32");
  assert.equal(mac.sources[0].path, join(options.home, "Library", "Application Support", "Code", "User", "mcp.json"));
  assert.equal(win.sources[0].path, join(options.home, "AppData", "Roaming", "Code", "User", "mcp.json"));
  assert.throws(() => localSourceLocations({ ...options, clients: ["codex", "codex"] }), /unique/);
  assert.throws(() => localSourceLocations({ ...options, clients: ["invented"] }));
});

test("local MCP discovery retains origins, namespaces different connections, and coalesces identical declarations", async (t) => {
  const options = await roots(t);
  const original = await source(join(options.home, ".codex/config.toml"), '[mcp_servers.docs]\nurl="https://docs.example/mcp"\n');
  await source(join(options.project, ".cursor/mcp.json"), { mcpServers: { same: remote(), docs: remote("https://other.example/mcp") } });
  await source(join(options.project, "opencode.jsonc"), '{"mcp":{"servers":{"files":{"type":"local","command":["node","server.mjs"]}}}}');
  const report = await prepareLocalImport(options);
  assert.equal(report.ready, true);
  assert.equal(report.available, 4);
  assert.equal(report.converted, 3);
  assert.equal(report.entries.find((item) => item.key === "cursor-project/same").duplicateOf, "codex-user/docs");
  assert.deepEqual(report.targets.map((item) => item.id), ["codex-user-docs-287fcec0a665", "opencode-project-jsonc-files-e38037c043e2", "cursor-project-docs-2adcb44c6a3b"]);
  assert.equal(report.metadataInspected, false);
  assert.equal(report.executionVerified, false);
  assert.equal(await readFile(join(options.home, ".codex/config.toml"), "utf8"), original);
  const selected = await prepareLocalImport({ ...options, select: ["cursor-project/same"] });
  assert.equal(selected.converted, 1);
  assert.equal(selected.targets[0].id, "cursor-project-same-cb2d9286ebbf");
});

test("client-specific Gemini transports and environment references retain their declared meanings", async (t) => {
  const options = await roots(t);
  await source(join(options.project, ".gemini/settings.json"), { mcpServers: {
    http: { httpUrl: "https://http.example/mcp", headers: { Authorization: "Bearer ${GEMINI_TOKEN}" } },
    events: { url: "https://events.example/sse" },
    local: { command: "node", env: { LOCAL_KEY: "${LOCAL_KEY}" } },
  } });
  await source(join(options.project, ".cursor/mcp.json"), { mcpServers: {
    auth: { ...remote(), headers: { Authorization: "Bearer ${env:CURSOR_TOKEN}" } },
  } });
  await source(join(options.project, ".vscode/mcp.json"), { servers: {
    files: { type: "stdio", command: "node", env: { FILE_KEY: "${env:FILE_KEY}" } },
  }, inputs: [{ id: "ignored", type: "promptString" }] });
  const report = await prepareLocalImport(options);
  assert.equal(report.ready, true);
  assert.equal(report.targets.find((item) => item.id === "gemini-cli-project-http-bfa9af4d48ac").connection.transport, "streamable-http");
  assert.equal(report.targets.find((item) => item.id === "gemini-cli-project-events-02c12349458c").connection.transport, "sse");
  assert.deepEqual(report.requiredEnvironmentVariables, ["CURSOR_TOKEN", "FILE_KEY", "GEMINI_TOKEN", "LOCAL_KEY"]);
  assert.ok(report.issues.every((issue) => issue.code !== "INLINE_ENV_OMITTED"));
});

test("Claude user, shared-project and current local scopes remain separate without importing other projects", async (t) => {
  const options = await roots(t);
  await source(join(options.home, ".claude.json"), { mcpServers: { docs: remote() }, projects: {
    [options.project]: { mcpServers: { local: remote("https://local.example/mcp") } },
    [join(options.project, "other")]: { mcpServers: { unrelated: remote("https://unrelated.example/mcp") } },
  } });
  await source(join(options.project, ".mcp.json"), { mcpServers: { shared: remote("https://shared.example/mcp") } });
  const report = await prepareLocalImport({ ...options, clients: ["claude-code"] });
  assert.deepEqual(report.entries.map((item) => item.key), ["claude-code-user/docs", "claude-code-project/shared", "claude-code-local/local"]);
  const project = await prepareLocalImport({ ...options, clients: ["claude-code"], scope: "project" });
  assert.equal(project.selected, 2);
  assert.equal(project.entries.some((item) => item.name === "unrelated"), false);
});

test("unsupported or malformed sources block a broad import but explicit valid selections remain usable and redacted", async (t) => {
  const options = await roots(t);
  await source(join(options.project, ".cursor/mcp.json"), { mcpServers: {
    good: remote(), bad: { ...remote("https://bad.example/mcp"), headers: { "X-API-Key": "private-header-secret" } },
    alias: { command: "node", env: { EXPECTED: "${env:OTHER}" } },
  } });
  await source(join(options.project, ".codex/config.toml"), 'invalid = "private-malformed-secret');
  const all = await prepareLocalImport(options);
  assert.equal(all.ready, false);
  const selected = await prepareLocalImport({ ...options, select: ["cursor-project/good"] });
  assert.equal(selected.ready, true);
  assert.equal(selected.targets.length, 1);
  assert.doesNotMatch(JSON.stringify(all), /private-header-secret|private-malformed-secret/);
  await assert.rejects(prepareLocalImport({ ...options, select: ["missing"] }), /discovered/);
  await assert.rejects(prepareLocalImport({ ...options, select: ["cursor-project/good", "cursor-project/good"] }), /unique/);
});

test("omitted inline values and different disabled states are never collapsed into one registration", async (t) => {
  const options = await roots(t);
  await source(join(options.project, ".mcp.json"), { mcpServers: {
    one: { command: "node", env: { KEY: "private-value-one" } },
    two: { command: "node", env: { KEY: "private-value-two" } },
    token: { ...remote(), headers: { Authorization: "Bearer private-inline-token" } },
    enabled: remote(), disabled: { ...remote(), disabled: true },
  } });
  const report = await prepareLocalImport(options);
  assert.equal(report.converted, 5);
  assert.equal(report.targets.find((item) => item.name === "disabled").enabled, false);
  assert.deepEqual(report.targets.find((item) => item.name === "token").connection.auth.envVars, ["MCP_CLAUDE_CODE_PROJECT_TOKEN_90ECB259A7D8_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(report), /private-value|private-inline-token/);
});

test("Gemini inline A2A cards preserve actual execution interfaces and skip local agents without execution", async (t) => {
  const options = await roots(t);
  await source(join(options.project, ".gemini/agents/research.md"), '---\nkind: remote\nname: researcher\nauth:\n  type: http\n  scheme: Bearer\n  token: $PEER_TOKEN\nagent_card_json: |\n  ' + JSON.stringify(card) + '\n---\nDo not execute these instructions.\n');
  await source(join(options.project, ".gemini/agents/local.md"), '---\nname: local-helper\ndescription: Local helper\n---\nLocal instructions.\n');
  const report = await prepareLocalImport(options);
  assert.equal(report.ready, true);
  assert.equal(report.converted, 1);
  const target = report.targets[0];
  assert.equal(target.protocol, "a2a");
  assert.equal(target.connection.url, card.url);
  assert.equal(target.connection.protocolBinding, "JSONRPC");
  assert.equal(target.connection.protocolVersion, "0.3.0");
  assert.deepEqual(target.connection.auth.envVars, ["PEER_TOKEN"]);
  assert.equal(report.executionVerified, false);
});

test("A2A card URLs remain pending offline and only explicit card inspection resolves an execution endpoint", async (t) => {
  const options = await roots(t);
  let calls = 0;
  const peer = await cardSource(t, async (request) => {
    calls++;
    assert.equal(request.headers.authorization, "Bearer private-provider-token");
    return card;
  });
  await source(join(options.project, ".gemini/agents/remote.md"), '---\nkind: remote\nname: remote-peer\nagent_card_url: ' + peer.url + '/custom-card\nauth:\n  type: http\n  scheme: Bearer\n  token: $PEER_TOKEN\n---\n');
  const pending = await prepareLocalImport(options);
  assert.equal(pending.ready, false);
  assert.equal(pending.targets.length, 0);
  assert.equal(pending.issues[0].code, "A2A_CARD_FETCH_REQUIRED");
  assert.equal(calls, 0);
  const fetched = await prepareLocalImport({ ...options, fetchA2aCards: true }, { PEER_TOKEN: "private-provider-token" });
  assert.equal(fetched.ready, true);
  assert.equal(fetched.targets[0].connection.url, card.url);
  assert.equal(fetched.targets[0].connection.agentCardUrl, peer.url + "/custom-card");
  assert.equal(fetched.metadataInspected, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(fetched), /private-provider-token/);
});

test("A2A unsupported auth and invalid selected declarations prevent every remote lookup", async (t) => {
  const options = await roots(t);
  let calls = 0;
  const peer = await cardSource(t, async () => { calls++; return card; });
  await source(join(options.project, ".gemini/agents/remote.md"), '---\n- kind: remote\n  name: public-peer\n  agent_card_url: ' + peer.url + '/custom-card\n- kind: remote\n  name: unsupported\n  agent_card_url: ' + peer.url + '/custom-card\n  auth:\n    type: google-credentials\n---\n');
  const report = await prepareLocalImport({ ...options, fetchA2aCards: true });
  assert.equal(report.ready, false);
  assert.equal(calls, 0);
  assert.throws(() => localAgents('---\nkind: remote\nkind: remote\nname: duplicated\n---\n'));
  assert.throws(() => localAgents('---\n- &peer\n  kind: remote\n  name: aliased\n- *peer\n---\n'));
  assert.throws(() => localAgents('---\nkind: remote\nname: unsafe\nauth: !command private-command-secret\n---\n'));
});

test("A2A lookup and directory bounds stop before metadata requests", async (t) => {
  const options = await roots(t);
  let calls = 0;
  const peer = await cardSource(t, async () => { calls++; return card; });
  const declarations = Array.from({ length: 11 }, (_, index) => "- kind: remote\n  name: peer-" + index + "\n  agent_card_url: " + peer.url + "/custom-card").join("\n");
  await source(join(options.project, ".gemini/agents/many.md"), "---\n" + declarations + "\n---\n");
  const report = await prepareLocalImport({ ...options, fetchA2aCards: true });
  assert.equal(report.ready, false);
  assert.equal(report.issues[0].code, "A2A_LOOKUP_LIMIT");
  assert.equal(calls, 0);
  const invalidPolicy = await cli(options, ["--fetch-a2a-cards", "--on-conflict", "invalid"]);
  assert.equal(invalidPolicy.code, 1);
  assert.equal(calls, 0);
  for (let index = 0; index < 100; index++) {
    await source(join(options.project, ".gemini/agents", "extra-" + index + ".md"), "ignored");
  }
  await assert.rejects(prepareLocalImport(options), /bounded local agent directory/);
});

test("aggregate source byte bounds stop preparation even when individual files fit", async (t) => {
  const options = await roots(t);
  const text = JSON.stringify({ mcpServers: {}, mcp: {}, servers: {} }).padEnd(1_000_000, " ");
  const paths = [...new Set(localSourceLocations(options).sources
    .filter((item) => item.kind === "mcp" && item.client !== "codex").map((item) => item.path))].slice(0, 9);
  for (const path of paths) {
    await source(path, text);
  }
  await assert.rejects(prepareLocalImport(options), /8 MiB/);
});

test("linked agent directories and malformed or oversized sources do not become trusted imports", async (t) => {
  const options = await roots(t);
  const actual = join(options.home, "actual-agents");
  await source(join(actual, "remote.md"), '---\nkind: remote\nname: peer\nagent_card_json: ' + JSON.stringify(JSON.stringify(card)) + '\n---\n');
  await mkdir(join(options.project, ".gemini"), { recursive: true });
  await symlink(actual, join(options.project, ".gemini/agents"), process.platform === "win32" ? "junction" : "dir");
  await source(join(options.project, ".cursor/mcp.json"), Buffer.alloc(1_048_577, 65).toString());
  const report = await prepareLocalImport(options);
  assert.equal(report.ready, false);
  assert.equal(report.converted, 0);
  assert.equal(report.sources.filter((item) => item.status === "error").length, 2);
});

test("installed-style CLI previews stay offline and selected atomic application uses administrator credentials", async (t) => {
  const options = await roots(t);
  const app = await fixture(t, { token: "private-admin", readToken: "private-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const original = await source(join(options.project, ".mcp.json"), { mcpServers: { docs: remote(), other: remote("https://other.example/mcp") } });
  const preview = await cli(options, ["--client", "claude-code", "--hub", "http://127.0.0.1:1"], { AGENT_TCDH_TOKEN: "invalid inherited credential" });
  assert.equal(preview.code, 0);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  const selected = ["--client", "claude-code", "--select", "claude-code-project/docs", "--hub", hub];
  const applied = await cli(options, [...selected, "--apply"], { AGENT_TCDH_TOKEN: "private-admin" });
  assert.equal(applied.code, 0);
  assert.equal(JSON.parse(applied.stdout).result.inserted, 1);
  const compared = await cli(options, [...selected, "--compare", "--on-conflict", "skip", "--token-env", "READER"], { READER: "private-reader" });
  assert.equal(compared.code, 0);
  assert.equal(JSON.parse(compared.stdout).hubConflictsChecked, true);
  assert.equal(JSON.parse(compared.stdout).applied, false);
  const conflict = await cli(options, ["--client", "claude-code", "--hub", hub, "--apply"], { AGENT_TCDH_TOKEN: "private-admin" });
  assert.equal(conflict.code, 1);
  assert.equal((await new HubClient(hub, "private-reader").search({})).total, 1);
  assert.equal(await readFile(join(options.project, ".mcp.json"), "utf8"), original);
});

test("local import rejects mixed modes and unknown options before any provider inspection", async (t) => {
  const options = await roots(t);
  for (const args of [["--apply", "--compare"], ["--apply", "--dry-run"], ["--details"], ["--format", "mcp-json"], ["--scope", "invalid"], ["--client", "invalid"]]) {
    const result = await cli(options, args);
    assert.equal(result.code, 1);
  }
});
