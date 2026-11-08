import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HubClient } from "../dist/client.js";
import { manageHubProfile, readHubProfiles } from "../dist/onboarding/hub-profiles.js";
import { editImportProfile } from "../dist/onboarding/import-profile-edit.js";
import { importLocalWorkflow, syncLocalWorkflow } from "../dist/onboarding/import-workflow.js";
import { readImportProfile } from "../dist/onboarding/import-profiles.js";
import { managementStatus } from "../dist/onboarding/status.js";
import { observeTargets } from "../dist/targets/observe.js";
import { batchTargetOptionsSchema } from "../dist/targets/batch.js";
import { definition, fixture, temporaryDirectory } from "./helpers.mjs";
import { mcpSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");

/** Write a synthetic client source beneath an isolated project directory. */
async function source(file, entries) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ mcpServers: entries }));
}

/** Run the public CLI with isolated setup and explicit profile paths. */
async function cli(dir, args, environment = {}) {
  if (environment.AGENT_TCDH_CONFIG === "") {
    environment = { ...environment, AGENT_TCDH_CONFIG: join(dir, "isolated-config.json") };
    await writeFile(environment.AGENT_TCDH_CONFIG, JSON.stringify({ formatVersion: 1, mode: "remote", hub: "http://127.0.0.1:1",
      server: { host: "127.0.0.1", port: 3000, dbPath: join(dir, "unused.sqlite") } }));
  }
  return execute(process.execPath, [entry, ...args], { timeout: 20000,
    env: { ...process.env, AGENT_TCDH_CONFIG: join(dir, "unused-config.json"), AGENT_TCDH_URL: "", AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "", ...environment } });
}

test("hub profiles preview writes, activate atomically, protect references, and clear removed active selections", async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "hubs.json");
  const config = { hub: "https://hub.example/", tokenEnv: "ADMIN_REF", readTokenEnv: "READ_REF" };
  await manageHubProfile("save", "work", file, config);
  assert.equal((await readHubProfiles(file)).text, undefined);
  await manageHubProfile("save", "work", file, config, true);
  const previous = await readFile(file, "utf8");
  const activated = await manageHubProfile("use", "work", file, undefined, true);
  assert.equal(await readFile(activated.backup, "utf8"), previous);
  assert.equal((await readHubProfiles(file)).store.active, "work");
  assert.doesNotMatch(await readFile(file, "utf8"), /Bearer|secret-value/);
  await assert.rejects(manageHubProfile("save", "work", file, config, true), /already exists/);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await manageHubProfile("remove", "work", file, undefined, true);
  assert.equal((await readHubProfiles(file)).store.active, undefined);
  await writeFile(file, '{"schemaVersion":1,"profiles":{"secret-value":1}}');
  await assert.rejects(readHubProfiles(file), (error) => !error.message.includes("secret-value"));
});

test("explicit and active hub profiles isolate credentials from unrelated defaults", async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "hubs.json");
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await manageHubProfile("save", "work", file, { hub, readTokenEnv: "WORK_READER" }, true);
  await manageHubProfile("use", "work", file, undefined, true);
  const flags = ["--hub-profiles-file", file];
  const env = { WORK_READER: "reader", AGENT_TCDH_TOKEN: "wrong-global", AGENT_TCDH_CONFIG: join(dir, "invalid-config") };
  assert.equal(JSON.parse((await cli(dir, ["target", "list", ...flags], env)).stdout).total, 0);
  const connected = JSON.parse((await cli(dir, ["connect", "codex", ...flags], env)).stdout);
  assert.ok(connected.requiredEnvironmentVariables.includes("WORK_READER"));
  await assert.rejects(cli(dir, ["target", "remove", "docs", ...flags], env), /only read credentials/);
  await assert.rejects(cli(dir, ["target", "list", "--hub-profile", "work", "--hub", "https://other.example", ...flags], env), /conflicts/);
  await manageHubProfile("save", "anonymous", file, { hub }, true);
  await assert.rejects(cli(dir, ["target", "list", "--hub-profile", "anonymous", ...flags], env), /401/);
  const shown = await cli(dir, ["hub-profile", "list", ...flags], env);
  assert.doesNotMatch(shown.stdout, /wrong-global|"reader"/);
  await assert.rejects(cli(dir, ["serve", "--hub-profile", "work", ...flags], env), /serve/);
});

test("editing source locations and selectors retains ownership and defers all registry changes to sync", async (t) => {
  const dir = await temporaryDirectory(t);
  const home = join(dir, "home");
  const project = join(dir, "old");
  const moved = join(dir, "new");
  const profilesFile = join(dir, "imports.json");
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  await source(join(project, ".cursor/mcp.json"), { a: { url: "https://a.example/mcp" }, b: { url: "https://b.example/mcp" } });
  await source(join(moved, ".cursor/mcp.json"), { a: { url: "https://changed.example/mcp" }, b: { url: "https://b.example/mcp" } });
  await importLocalWorkflow(client, hub, { home, project, clients: ["cursor"], scope: "project", profilesFile, saveProfile: "work", apply: true });
  const previous = await readImportProfile("work", profilesFile);
  const preview = await editImportProfile("work", profilesFile, { project: moved, select: ["cursor-project/a"] });
  assert.equal(preview.applied, false);
  assert.deepEqual(await readImportProfile("work", profilesFile), previous);
  await editImportProfile("work", profilesFile, { project: moved, select: ["cursor-project/a"], apply: true });
  const edited = await readImportProfile("work", profilesFile);
  assert.deepEqual(edited.bindings, previous.bindings);
  assert.equal(edited.sources[0].path, join(moved, ".cursor/mcp.json"));
  assert.equal((await client.get(previous.bindings[0].id)).connection.url, "https://a.example/mcp");
  const plan = await syncLocalWorkflow(client, hub, { profile: "work", profilesFile, prune: true });
  assert.ok(plan.plan.items.some((item) => item.action === "updated"));
  assert.ok(plan.plan.items.some((item) => item.action === "removed"));
  await syncLocalWorkflow(client, hub, { profile: "work", profilesFile, prune: true, apply: true });
  await assert.rejects(client.get(previous.bindings[1].id), /404/);
  await assert.rejects(editImportProfile("work", profilesFile, { sourcePaths: ["missing=/tmp/file"], apply: true }), /known source/);
});

test("status reports source drift, missing references and unknown metadata without provider calls", async (t) => {
  const dir = await temporaryDirectory(t);
  const provider = await mcpSource(t);
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  await client.create(definition("docs", { connection: { transport: "streamable-http", url: provider.url + "/mcp", auth: { type: "bearer", envVars: ["MISSING"] } } }));
  const result = await managementStatus({ hub, profilesFile: join(dir, "profiles.json") }, {});
  assert.equal(result.counts.total, 1);
  assert.equal(result.freshness.items[0].state, "unknown");
  assert.deepEqual(result.variables, [{ name: "MISSING", available: false }]);
  assert.equal(provider.state.listCalls, 0);
  assert.equal(result.providerRequests, false);
  assert.equal(result.executionVerified, false);
});

test("observations preview offline, persist metadata only, select stale/failures, and refresh to a committed version", async (t) => {
  const provider = await mcpSource(t);
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  await client.create(definition("docs", { capabilities: [], connection: { transport: "streamable-http", url: provider.url + "/mcp" } }));
  const options = batchTargetOptionsSchema.parse({ select: ["docs"] });
  assert.equal((await observeTargets(client, options, {})).outcomes[0].status, "planned");
  assert.equal(provider.state.listCalls, 0);
  assert.equal((await observeTargets(client, options, { apply: true })).outcomes[0].status, "warning");
  const refreshed = await observeTargets(client, options, { apply: true, staleOnly: true, refresh: true });
  assert.equal(refreshed.outcomes[0].status, "passed");
  const fresh = await client.freshness({ limit: 100, offset: 0, staleHours: 24 });
  assert.equal(fresh.items[0].state, "fresh");
  assert.equal(fresh.items[0].status, "passed");
  assert.equal((await observeTargets(client, options, { apply: true, staleOnly: true })).outcomes.length, 0);
  assert.equal(provider.state.calls, 0);
});

test("concurrent definition edits prevent a metadata observation from being stamped as current", async (t) => {
  let client;
  const provider = await mcpSource(t, { onList: async () => {
    const old = (await client.getVersioned("docs")).target;
    await client.update("docs", definition("docs", { name: "Concurrent", connection: old.connection }));
  } });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  client = new HubClient(hub);
  await client.create(definition("docs", { connection: { transport: "streamable-http", url: provider.url + "/mcp" } }));
  const result = await observeTargets(client, batchTargetOptionsSchema.parse({ select: ["docs"] }), { apply: true });
  assert.equal(result.outcomes[0].recorded, false);
  assert.equal((await client.freshness({ limit: 1, offset: 0, staleHours: 24 })).items[0].state, "unknown");
});

test("guided setup previews without writes and applies registration/profile/client output using explicit destinations", async (t) => {
  const dir = await temporaryDirectory(t);
  const home = join(dir, "home");
  const project = join(dir, "project");
  const file = join(dir, "consumer.toml");
  const profiles = join(dir, "imports.json");
  await source(join(project, ".cursor/mcp.json"), { docs: { url: "https://docs.example/mcp" } });
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const flags = ["setup", "--yes", "--client", "codex", "--hub", hub, "--home", home, "--project", project,
    "--scope", "project", "--select", "cursor-project/docs", "--write", file, "--save-profile", "work", "--profiles-file", profiles];
  const preview = JSON.parse((await cli(dir, flags, { AGENT_TCDH_CONFIG: "" })).stdout);
  assert.equal(preview.applied, false);
  await assert.rejects(readFile(file));
  await assert.rejects(readFile(profiles));
  const applied = JSON.parse((await cli(dir, [...flags, "--apply", "--token-env", "ADMIN"], { ADMIN: "admin", AGENT_TCDH_CONFIG: "" })).stdout);
  assert.equal(applied.applied, true);
  assert.equal(applied.connection.changed, true);
  assert.equal((await readImportProfile("work", profiles)).bindings.length, 1);
  assert.match(await readFile(file, "utf8"), /agent_tcdh/);
  assert.equal((await app.inject({ url: "/api/targets", headers: { authorization: "Bearer reader" } })).json().total, 1);
});

test("setup preflights conflicting client files before registration and profile editing keeps malformed sources unchanged", async (t) => {
  const dir = await temporaryDirectory(t);
  const home = join(dir, "home");
  const project = join(dir, "project");
  const profilesFile = join(dir, "imports.json");
  const destination = join(dir, "existing.toml");
  const file = join(project, ".cursor", "mcp.json");
  await source(file, { docs: { url: "https://docs.example/mcp" } });
  await writeFile(destination, '[mcp_servers.agent_tcdh]\nurl="https://unrelated.example/mcp"\n');
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await assert.rejects(cli(dir, ["setup", "--yes", "--client", "codex", "--hub", hub, "--home", home, "--project", project,
    "--scope", "project", "--select", "cursor-project/docs", "--write", destination, "--apply"], { AGENT_TCDH_CONFIG: "" }), /already|replace/);
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  const client = new HubClient(hub);
  await importLocalWorkflow(client, hub, { home, project, scope: "project", clients: ["cursor"], profilesFile, saveProfile: "work" });
  const previous = await readFile(profilesFile, "utf8");
  await writeFile(file, '{"secret-value":');
  await assert.rejects(editImportProfile("work", profilesFile, { allSources: true, apply: true }), /not ready/);
  assert.equal(await readFile(profilesFile, "utf8"), previous);
});

test("guided setup reports a later client-file failure while retaining acknowledged registrations", async (t) => {
  const { setupConsumer } = await import("../dist/onboarding/setup.js");
  const dir = await temporaryDirectory(t);
  const home = join(dir, "home");
  const project = join(dir, "project");
  const profilesFile = join(dir, "imports.json");
  const destination = join(dir, "consumer.toml");
  await source(join(project, ".cursor", "mcp.json"), { docs: { url: "https://docs.example/mcp" } });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  const original = client.importRegistry.bind(client);
  client.importRegistry = async (...args) => {
    const result = await original(...args);
    await writeFile(destination, '[mcp_servers.agent_tcdh]\nurl="https://concurrent.example/mcp"\n');
    return result;
  };
  const result = await setupConsumer(client, hub, { client: "codex", yes: true, apply: true, home, project, scope: "project",
    select: ["cursor-project/docs"], write: destination, profilesFile, saveProfile: "work" });
  assert.equal(result.applied, true);
  assert.equal(result.connectionFailed, true);
  assert.equal(result.failed, true);
  assert.equal((await readImportProfile("work", profilesFile)).bindings.length, 1);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
  assert.match(await readFile(destination, "utf8"), /concurrent.example/);
});
