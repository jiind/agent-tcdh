import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { importLocalWorkflow, syncLocalWorkflow } from "../dist/onboarding/import-workflow.js";
import { readImportProfile, readImportProfiles, definitionHashes } from "../dist/onboarding/import-profiles.js";
import { selectImportEntries } from "../dist/onboarding/import-select.js";
import { prepareLocalImport } from "../dist/onboarding/local-import.js";
import { planImportSync, applyImportSync } from "../dist/onboarding/import-sync.js";
import { fixture, temporaryDirectory } from "./helpers.mjs";
import { mcpSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const remote = (url = "https://docs.example/mcp") => ({ type: "http", url });

/** Write one isolated foreign client configuration without modifying contributor settings. */
async function source(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

/** Prepare independent user/project/profile files and a loopback authenticated registry. */
async function setup(t, entries = { docs: remote() }) {
  const directory = await temporaryDirectory(t);
  const home = join(directory, "foreign home");
  const project = join(directory, "foreign project");
  const profilesFile = join(directory, "private profiles.json");
  const file = join(project, ".cursor", "mcp.json");
  await source(file, { mcpServers: entries });
  const app = await fixture(t, { token: "private-admin", readToken: "private-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  return { directory, home, project, profilesFile, file, app, hub, client: new HubClient(hub, "private-admin"),
    options: { home, project, clients: ["cursor"], profilesFile } };
}

/** Apply an initial managed import and return its single tracked profile. */
async function managed(state, extras = {}, environment = process.env) {
  const report = await importLocalWorkflow(state.client, state.hub, { ...state.options, ...extras, saveProfile: "work", apply: true }, environment);
  assert.equal(report.applied, true);
  assert.equal(report.profileSaved, true);
  return { report, profile: await readImportProfile("work", state.profilesFile) };
}

test("profiles save fixed source locations and selectors offline without copying commands or credential values", async (t) => {
  const state = await setup(t, { local: { command: "node", args: ["private-script-argument"], env: { TOKEN: "private-inline-secret" } } });
  const report = await importLocalWorkflow(new HubClient("http://127.0.0.1:1"), "http://127.0.0.1:1", {
    ...state.options, saveProfile: "work", select: ["cursor-project/local"],
  });
  assert.equal(report.applied, false);
  assert.equal(report.profileSaved, true);
  const text = await readFile(state.profilesFile, "utf8");
  assert.doesNotMatch(text, /private-script-argument|private-inline-secret|"command"|"envVars"/);
  const profile = await readImportProfile("work", state.profilesFile);
  assert.equal(profile.bindings.length, 0);
  assert.deepEqual(profile.select, ["cursor-project/local"]);
  assert.equal(profile.sources.find((item) => item.id === "cursor-project").path, state.file);
  await assert.rejects(importLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile }), /different hub/);
});

test("managed synchronization previews source additions/changes/removals and preserves no-op revisions", async (t) => {
  const state = await setup(t, { docs: remote(), old: remote("https://old.example/mcp") });
  const { profile } = await managed(state);
  const docs = profile.bindings.find((binding) => binding.origins.includes("cursor-project/docs")).id;
  const old = profile.bindings.find((binding) => binding.origins.includes("cursor-project/old")).id;
  const before = await state.client.getVersioned(docs);
  const noop = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true });
  assert.equal(noop.plan.counts.unchanged, 2);
  assert.equal((await state.client.getVersioned(docs)).etag, before.etag);
  await source(state.file, { mcpServers: { docs: remote("https://updated.example/mcp"), added: remote("https://added.example/mcp") } });
  const preview = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile });
  assert.equal(preview.plan.counts.added, 1);
  assert.equal(preview.plan.counts.updated, 1);
  assert.equal(preview.plan.counts.retained, 1);
  assert.equal(preview.applied, false);
  assert.equal((await state.client.get(docs)).connection.url, "https://docs.example/mcp");
  const applied = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true });
  assert.equal(applied.failed, false);
  assert.equal((await state.client.get(docs)).connection.url, "https://updated.example/mcp");
  assert.equal((await state.client.get(old)).id, old);
  const pruned = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, prune: true, apply: true });
  assert.equal(pruned.plan.counts.removed, 1);
  await assert.rejects(state.client.get(old), /HTTP 404/);
  assert.equal((await readImportProfile("work", state.profilesFile)).bindings.length, 2);
});

test("three-way sync preserves hub-only fields and blocks conflicting source/hub edits before any writes", async (t) => {
  const state = await setup(t);
  const { profile } = await managed(state);
  const id = profile.bindings[0].id;
  await state.client.update(id, { ...(await state.client.get(id)), createdAt: undefined, updatedAt: undefined, tags: ["administrator"] });
  await source(state.file, { mcpServers: { docs: remote("https://changed.example/mcp") } });
  const merged = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true });
  assert.equal(merged.failed, false);
  assert.deepEqual((await state.client.get(id)).tags, ["administrator"]);
  const current = await state.client.get(id);
  await state.client.update(id, { ...current, createdAt: undefined, updatedAt: undefined,
    connection: { ...current.connection, url: "https://administrator.example/mcp" } });
  await source(state.file, { mcpServers: { docs: remote("https://source.example/mcp"), new: remote("https://new.example/mcp") } });
  const conflict = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true });
  assert.equal(conflict.applied, false);
  assert.equal(conflict.plan.counts.conflict, 1);
  assert.equal(conflict.plan.items.find((item) => item.action === "conflict").issue, "SOURCE_AND_HUB_CHANGED");
  assert.equal((await state.client.search({})).total, 1);
  assert.equal((await state.client.get(id)).connection.url, "https://administrator.example/mcp");
});

test("fixed-selection source errors block pruning while genuine removals retain modified registrations", async (t) => {
  const state = await setup(t);
  const { profile } = await managed(state, { select: ["cursor-project/docs"] });
  const id = profile.bindings[0].id;
  await source(state.file, '{"mcpServers":{"private-malformed-secret');
  const invalid = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true, prune: true });
  assert.equal(invalid.applied, false);
  assert.equal(invalid.plan.items[0].issue, "SOURCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(invalid), /private-malformed-secret/);
  const current = await state.client.get(id);
  await state.client.update(id, { ...current, createdAt: undefined, updatedAt: undefined, description: "Administrator annotation" });
  await source(state.file, { mcpServers: {} });
  const retained = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true, prune: true });
  assert.equal(retained.applied, false);
  assert.equal(retained.plan.items[0].issue, "ORPHAN_CHANGED_IN_HUB");
  assert.equal((await state.client.get(id)).description, "Administrator annotation");
});

test("conditional sync conflicts are not retried and keep successful independent outcomes in the ledger", async (t) => {
  const state = await setup(t);
  const { profile } = await managed(state);
  await source(state.file, { mcpServers: { docs: remote("https://changed.example/mcp"), added: remote("https://added.example/mcp") } });
  const preparation = await prepareLocalImport({ project: profile.project, scope: profile.scope, sourceLocations: profile.sources });
  const plan = await planImportSync(state.client, profile, preparation);
  let attempts = 0;
  const observed = {
    getVersioned: (id) => state.client.getVersioned(id), importRegistry: (snapshot, options) => state.client.importRegistry(snapshot, options), remove: (id, etag) => state.client.remove(id, etag),
    update: async (id, target, etag) => {
      attempts++;
      const current = await state.client.get(id);
      await state.client.update(id, { ...current, createdAt: undefined, updatedAt: undefined, name: "Intervening administrator" });
      return state.client.update(id, target, etag);
    },
  };
  const result = await applyImportSync(observed, profile, plan);
  assert.equal(attempts, 1);
  assert.equal(result.failed, true);
  assert.equal(result.bindings.length, 2);
  assert.equal(result.outcomes.filter((item) => item.status === "failed").length, 1);
  assert.deepEqual(result.bindings.find((item) => item.id === profile.bindings[0].id), profile.bindings[0]);
});

test("profile locking and malformed state reject mutations without exposing private storage contents", async (t) => {
  const state = await setup(t);
  await managed(state);
  await source(state.file, { mcpServers: { extra: remote() } });
  await writeFile(state.profilesFile + ".operation.lock", "owned");
  await assert.rejects(syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true }), /operation is in progress/);
  assert.equal((await state.client.search({})).total, 1);
  await rm(state.profilesFile + ".operation.lock");
  await writeFile(state.profilesFile, 'private-invalid-profile-secret');
  await assert.rejects(readImportProfiles(state.profilesFile), (error) => !String(error).includes("private-invalid-profile-secret"));
});

test("metadata follow-up uses one provider observation and records only metadata changes in the private ledger", async (t) => {
  let profilesFile;
  const sourceServer = await mcpSource(t, { forceCloseConnections: true, token: "private-provider", pages: [{ tools: [
    { name: "search", description: "Search", inputSchema: { type: "object" } },
  ] }], onList: async () => {
    assert.equal((await readImportProfile("work", profilesFile)).bindings.length, 1, "Ownership must be checkpointed before optional metadata requests.");
  } });
  const state = await setup(t, { docs: { ...remote(sourceServer.url + "/mcp"), headers: { Authorization: "Bearer ${env:PROVIDER_TOKEN}" } } });
  profilesFile = state.profilesFile;
  const { report, profile } = await managed(state, { refresh: true, diagnose: true }, { ...process.env, PROVIDER_TOKEN: "private-provider", AGENT_TCDH_TOKEN: "private-admin" });
  assert.equal(report.followUp.failed, false);
  assert.equal(report.followUp.outcomes[0].diagnosis, "matched");
  assert.equal(sourceServer.state.listCalls, 1);
  assert.equal(sourceServer.state.calls, 0);
  assert.ok(sourceServer.state.headers.every((header) => header === "Bearer private-provider"));
  const current = await state.client.get(profile.bindings[0].id);
  assert.equal(current.capabilities[0].name, "search");
  assert.equal(profile.bindings[0].destinationHashes.capabilities, definitionHashes(current).capabilities);
  assert.doesNotMatch(await readFile(state.profilesFile, "utf8"), /private-provider|private-admin/);
  const noop = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile });
  assert.equal(noop.plan.counts.unchanged, 1);
});

test("managed capacity is checked before registration and missing managed targets are never silently recreated", async (t) => {
  const state = await setup(t);
  const { profile } = await managed(state);
  await state.client.remove(profile.bindings[0].id);
  const missing = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true });
  assert.equal(missing.applied, false);
  assert.equal(missing.plan.items[0].issue, "MANAGED_TARGET_MISSING");
  const entries = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => ["n" + index, remote("https://docs.example/" + index)]));
  await source(state.file, { mcpServers: entries });
  await assert.rejects(importLocalWorkflow(state.client, state.hub, { ...state.options, saveProfile: "too-large", apply: true }), /at most 1000/);
  assert.equal((await state.client.search({})).total, 0);
});

test("stdio follow-up skips startup by default and starts only with explicit inspection authorization", async (t) => {
  const events = join(await temporaryDirectory(t), "events.jsonl");
  const state = await setup(t, { local: { command: process.execPath, args: [resolve("test/stdio-inspection-server.mjs"), "normal"],
    env: { INSPECTION_EVENTS: "${env:INSPECTION_EVENTS}", INSPECTION_TOKEN: "${env:INSPECTION_TOKEN}" } } });
  const environment = { ...process.env, INSPECTION_EVENTS: events, INSPECTION_TOKEN: "private-local-token" };
  const { report, profile } = await managed(state, { refresh: true, diagnose: true }, environment);
  assert.equal(report.followUp.outcomes[0].status, "skipped");
  await assert.rejects(readFile(events), { code: "ENOENT" });
  const inspected = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true,
    refresh: true, diagnose: true, inspectStdio: true }, environment);
  assert.equal(inspected.failed, false);
  assert.equal(inspected.followUp.outcomes[0].updated, true);
  assert.equal((await state.client.get(profile.bindings[0].id)).capabilities[0].name, "read_metadata_0");
  assert.doesNotMatch(await readFile(events, "utf8"), /tool-called/);
  assert.doesNotMatch(await readFile(state.profilesFile, "utf8"), /private-local-token|stdio-inspection-server/);
});

test("failed optional inspection leaves successful registration tracked and never rolls it back", async (t) => {
  const state = await setup(t, { docs: remote("http://127.0.0.1:1/mcp") });
  const { report, profile } = await managed(state, { refresh: true, diagnose: true });
  assert.equal(report.applied, true);
  assert.equal(report.failed, true);
  assert.equal(report.followUp.failed, true);
  assert.equal(profile.bindings.length, 1);
  assert.equal((await state.client.search({})).total, 1);
});

test("coalesced origin changes keep the existing managed target ID", async (t) => {
  const state = await setup(t, { alias: remote() });
  await source(join(state.home, ".codex/config.toml"), '[mcp_servers.docs]\nurl="https://docs.example/mcp"\n');
  const { profile } = await managed(state, { clients: undefined });
  assert.equal(profile.bindings[0].origins.length, 2);
  const id = profile.bindings[0].id;
  await rm(join(state.home, ".codex/config.toml"));
  const synced = await syncLocalWorkflow(state.client, state.hub, { profile: "work", profilesFile: state.profilesFile, apply: true });
  assert.equal(synced.failed, false);
  assert.equal((await state.client.search({})).total, 1);
  assert.equal((await readImportProfile("work", state.profilesFile)).bindings[0].id, id);
  assert.equal((await state.client.get(id)).name, "alias");
});

test("terminal checkbox selection and cancellation restore terminal ownership", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const raw = [];
  input.isTTY = true;
  output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { raw.push(value); input.isRaw = value; };
  const choices = [{ key: "one", name: "One", protocol: "mcp", status: "ready" }, { key: "two", name: "Two", protocol: "a2a", status: "ready" }];
  const selection = selectImportEntries(choices, input, output);
  input.emit("keypress", " ", { name: "space" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", " ", { name: "space" });
  input.emit("keypress", "", { name: "up" });
  input.emit("keypress", " ", { name: "space" });
  input.emit("keypress", "\r", { name: "return" });
  assert.deepEqual(await selection, ["two"]);
  assert.deepEqual(raw, [true, false]);
  const cancellation = selectImportEntries(choices, input, output);
  input.emit("keypress", "", { name: "escape" });
  await assert.rejects(cancellation, /cancelled/);
  assert.equal(input.isRaw, false);
  await assert.rejects(selectImportEntries(choices, new PassThrough(), output), /terminal/);
});

test("CLI profile reuse, previewed removal, sync and invalid execution options preserve offline boundaries", async (t) => {
  const state = await setup(t);
  const base = [resolve("dist/index.js")];
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  const created = await execute(process.execPath, [...base, "registry", "import-local", "--home", state.home, "--project", state.project,
    "--save-profile", "work", "--profiles-file", state.profilesFile, "--hub", state.hub, "--token-env", "ADMIN_REFERENCE"], { env: { ...env, ADMIN_REFERENCE: "private-admin" } });
  assert.equal(JSON.parse(created.stdout).profileSaved, true);
  const applied = await execute(process.execPath, [...base, "registry", "import-local", "--profile", "work", "--profiles-file", state.profilesFile, "--apply"],
    { env: { ...env, ADMIN_REFERENCE: "private-admin", AGENT_TCDH_TOKEN: "wrong-default-hub-token", AGENT_TCDH_CONFIG: join(state.directory, "missing-unrelated-setup.json") } });
  assert.equal(JSON.parse(applied.stdout).result.inserted, 1);
  const synced = await execute(process.execPath, [...base, "registry", "sync-local", "--profile", "work", "--profiles-file", state.profilesFile,
    "--token-env", "READER"], { env: { ...env, READER: "private-reader" } });
  assert.equal(JSON.parse(synced.stdout).plan.counts.unchanged, 1);
  const removed = await execute(process.execPath, [...base, "import-profile", "remove", "work", "--profiles-file", state.profilesFile], { env });
  assert.equal(JSON.parse(removed.stdout).removed, false);
  assert.equal((await readImportProfile("work", state.profilesFile)).bindings.length, 1);
  for (const flags of [["--interactive", "--select", "cursor-project/docs"], ["--refresh"], ["--inspect-stdio", "--apply"], ["--stdio-cwd", state.project]]) {
    await assert.rejects(execute(process.execPath, [...base, "registry", "import-local", "--home", state.home, "--project", state.project, ...flags], { env }));
  }
});

if (process.platform !== "win32") {
  test("a graceful CLI interrupt stops later stdio inspections and retains acknowledged profile ownership", async (t) => {
    const directory = await temporaryDirectory(t);
    const first = join(directory, "first.jsonl");
    const fixtureCommand = resolve("test/stdio-inspection-server.mjs");
    const local = (mode, args = []) => ({ command: process.execPath, args: [fixtureCommand, mode, ...args],
      env: { INSPECTION_EVENTS: "${env:INSPECTION_EVENTS}", INSPECTION_TOKEN: "${env:INSPECTION_TOKEN}" } });
    const state = await setup(t, { first: local("hang"), later: local("normal", ["later"]) });
    let child;
    const env = { ...process.env, AGENT_TCDH_TOKEN: "private-admin", AGENT_TCDH_READ_TOKEN: "", INSPECTION_EVENTS: first, INSPECTION_TOKEN: "fixture-token" };
    delete env.AGENT_TCDH_CONFIG;
    delete env.AGENT_TCDH_URL;
    const completion = new Promise((accept) => {
      child = execFile(process.execPath, [resolve("dist/index.js"), "registry", "import-local", "--home", state.home, "--project", state.project,
        "--client", "cursor", "--save-profile", "interrupted", "--profiles-file", state.profilesFile, "--hub", state.hub,
        "--apply", "--refresh", "--inspect-stdio"], { env, timeout: 20_000 }, (error, stdout, stderr) => accept({ code: error?.code ?? 0, stdout, stderr }));
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await completion;
    });
    let started = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      try {
        started = (await readFile(first, "utf8")).includes('"started"');
      } catch {
        // Wait for the owned fixture's startup event rather than assuming a timing overlap.
      }
      if (started) {
        break;
      }
      await delay(20);
    }
    assert.equal(started, true);
    child.kill("SIGINT");
    const result = await completion;
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.applied, true);
    assert.equal(report.followUp.outcomes[0].issue, "INSPECTION_CANCELLED");
    assert.equal(report.followUp.outcomes[1].status, "skipped");
    assert.equal((await readImportProfile("interrupted", state.profilesFile)).bindings.length, 2);
    assert.equal((await readFile(first, "utf8")).trim().split("\n").filter((line) => line.includes('"started"')).length, 1);
  });
}
