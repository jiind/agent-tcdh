import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "node:util";
import { availablePort, runCommand, verifyRuntime, waitForHub } from "./smoke-runtime.mjs";

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, tarball: { type: "string" } } });
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "agent-tcdh package-"));
let child;

/** Stop the installed package process, escalating to termination if necessary. */
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

try {
  // 1. Verify required files and documentation in the built package.
  let tarball = values.tarball ? resolve(values.tarball) : undefined;
  if (!tarball) {
    const packed = await runCommand("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: project });
    const output = JSON.parse(packed.stdout);
    const [manifest] = Array.isArray(output) ? output : Object.values(output);
    tarball = join(directory, manifest.filename);
  }
  const packed = await runCommand("npm", ["pack", tarball, "--dry-run", "--ignore-scripts", "--json"], { cwd: directory });
  const output = JSON.parse(packed.stdout);
  const manifests = Array.isArray(output) ? output : Object.values(output);
  assert.equal(manifests.length, 1, "Exactly one package must be inspected.");
  const [manifest] = manifests;
  assert.equal(manifest.name, "agent-tcdh");
  const files = new Set(manifest.files.map((entry) => entry.path));
  for (const required of ["dist/index.js", "dist/version.js", "dist/onboarding/connect.js", "dist/onboarding/disconnect.js", "dist/onboarding/restore.js", "dist/onboarding/backups.js", "dist/onboarding/doctor.js", "dist/onboarding/doctor-batch.js", "docs/onboarding.md", "docs/client-connections.md", "docs/connection-check.md", "docs/client-disconnection.md", "docs/configuration-restore.md", "docs/configuration-backups.md", "dist/onboarding/import-config.js", "dist/onboarding/presets.js", "docs/config-import.md", "dist/app.js", "dist/a2a-http.js", "dist/targets/check.js", "dist/targets/batch.js", "dist/targets/refresh-batch.js", "docs/batch-refresh.md", "docs/target-selection.md", "dist/targets/edit.js", "dist/registry/diff.js", "docs/registry-comparison.md", "docs/target-management.md", "docs/agent-compatibility.md", "docs/agent-verification.md", "examples/a2a.json", "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) {
    assert.ok(files.has(required), "Required package file is missing: " + required);
  }
  for (const required of ["examples/local-demo.mjs", "examples/demo-targets.mjs", "docs/local-demo.md", "examples/public-docs-registry.json", "docs/public-mcp-verification.md", "docs/selection-verification.md", "docs/model-target-verification.md", "docs/platform-compatibility.md", "docs/reference.md"]) {
    assert.ok(files.has(required), "Local demo artifact is missing: " + required);
  }
  assert.ok(files.has("docs/releases/v" + manifest.version + ".md"), "Matching versioned release notes must be packaged.");
  for (const required of ["dist/onboarding/local-import.js", "dist/onboarding/local-sources.js", "dist/onboarding/local-a2a.js", "docs/local-import.md"]) {
    assert.ok(files.has(required), "Local client import artifact is missing: " + required);
  }
  for (const required of ["dist/onboarding/import-profiles.js", "dist/onboarding/import-select.js", "dist/onboarding/import-sync.js",
    "dist/onboarding/import-follow-up.js", "dist/onboarding/import-workflow.js", "dist/registry/duplicates.js", "dist/stdio-inspect.js", "docs/import-management.md"]) {
    assert.ok(files.has(required), "Import-management artifact is missing: " + required);
  }
  assert.equal([...files].some((file) => /^(src|test|node_modules|\.github)\//u.test(file) || /(^|\/)\.env(?:\.|$)|\.sqlite(?:$|-)/u.test(file)), false);

  // 2. Install production dependencies in isolation from the repository's development dependencies.
  const installation = join(directory, "consumer");
  await mkdir(installation);
  await runCommand("npm", ["install", "--prefix", installation, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock=false", ...(values.offline ? ["--offline"] : []), tarball], { cwd: installation });
  const installed = join(installation, "node_modules", "agent-tcdh");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const executable = process.platform === "win32" ? process.execPath : join(installation, "node_modules", ".bin", "agent-tcdh");
  const prefix = process.platform === "win32" ? [join(installed, metadata.bin[metadata.name])] : [];
  const help = await runCommand(executable, [...prefix, "--help"], { cwd: installation });
  assert.ok(help.stdout.includes("AgentTCDH"));

  const installedVersion = await runCommand(executable, [...prefix, "--version"], { cwd: installation });
  assert.equal(installedVersion.stdout, metadata.version + "\n");
  const localIdentity = await runCommand(executable, [...prefix, "--version", "--json"], { cwd: installation,
    env: { ...process.env, AGENT_TCDH_CONFIG: join(directory, "missing-setup.json"), AGENT_TCDH_URL: "invalid-hub-url",
      AGENT_TCDH_TOKEN: "must not resolve this invalid credential" } });
  const identity = JSON.parse(localIdentity.stdout);
  assert.deepEqual(identity, { name: metadata.name, version: metadata.version, node: process.versions.node,
    platform: process.platform, arch: process.arch });

  // 3. Start the installed CLI and verify protocols before and after restarting.
  const port = await availablePort();
  const url = "http://127.0.0.1:" + port;
  const credentials = { adminToken: randomUUID(), readToken: randomUUID() };
  const environment = { ...process.env, AGENT_TCDH_TOKEN: credentials.adminToken,
    AGENT_TCDH_READ_TOKEN: credentials.readToken, AGENT_TCDH_PUBLIC_URL: url, AGENT_TCDH_ALLOWED_ORIGINS: "" };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  /** Start the deployed artifact using a dedicated verification database. */
  async function startServer() {
    child = spawn(executable, [...prefix, "serve", "--host", "127.0.0.1", "--port", String(port),
      "--db", join(directory, "registry.sqlite")], { cwd: installation, env: environment, stdio: ["ignore", "ignore", "ignore"] });
    await once(child, "spawn");
    await waitForHub(url, () => child.exitCode === null && child.signalCode === null);
  }
  // Exercise onboarding from the installed artifact using only isolated configuration files.
  const setupPath = join(directory, "setup.json");
  await runCommand(executable, [...prefix, "init", "--yes", "--config", setupPath, "--hub", url,
    "--port", String(port), "--db", join(directory, "registry.sqlite"),
    "--token-env", "AGENT_TCDH_TOKEN", "--read-token-env", "AGENT_TCDH_READ_TOKEN"], { cwd: installation, env: environment });
  environment.AGENT_TCDH_CONFIG = setupPath;
  const consumerConfig = join(directory, "consumer.jsonc");
  const connected = await runCommand(executable, [...prefix, "connect", "opencode", "--write", consumerConfig], { cwd: installation, env: environment });
  assert.equal(JSON.parse(connected.stdout).changed, true);
  assert.ok((await readFile(consumerConfig, "utf8")).includes("AGENT_TCDH_READ_TOKEN"));
  // Check the installed profile before starting the hub, proving configuration checks stay offline.
  const connectionCheck = await runCommand(executable, [...prefix, "connect", "opencode", "--check", consumerConfig], { cwd: installation, env: environment });
  assert.equal(JSON.parse(connectionCheck.stdout).reason, "matched");
  assert.equal(JSON.parse(connectionCheck.stdout).executionVerified, false);
  const savedConsumer = await readFile(consumerConfig, "utf8");
  const disconnectPreview = await runCommand(executable, [...prefix, "disconnect", "opencode", "--file", consumerConfig], { cwd: installation, env: environment });
  assert.equal(JSON.parse(disconnectPreview.stdout).reason, "removal-ready");
  assert.equal(await readFile(consumerConfig, "utf8"), savedConsumer);
  const disconnected = await runCommand(executable, [...prefix, "disconnect", "opencode", "--file", consumerConfig, "--apply"], { cwd: installation, env: environment });
  const removal = JSON.parse(disconnected.stdout);
  assert.equal(removal.applied, true);
  assert.equal(await readFile(removal.backup, "utf8"), savedConsumer);
  assert.deepEqual(JSON.parse(await readFile(consumerConfig, "utf8")).mcp.servers, {});
  const afterRemoval = await readFile(consumerConfig, "utf8");
  const restorePreview = await runCommand(executable, [...prefix, "config", "restore", removal.backup, "--file", consumerConfig], { cwd: installation, env: environment });
  assert.equal(JSON.parse(restorePreview.stdout).reason, "restore-ready");
  assert.equal(await readFile(consumerConfig, "utf8"), afterRemoval);
  const restored = await runCommand(executable, [...prefix, "config", "restore", removal.backup, "--file", consumerConfig, "--apply"], { cwd: installation, env: environment });
  const recovery = JSON.parse(restored.stdout);
  assert.equal(recovery.reason, "restored");
  assert.equal(await readFile(consumerConfig, "utf8"), savedConsumer);
  assert.equal(await readFile(recovery.backup, "utf8"), afterRemoval);
  assert.equal(await readFile(removal.backup, "utf8"), savedConsumer);
  const listedBackups = await runCommand(executable, [...prefix, "config", "backups", "--file", consumerConfig], { cwd: installation, env: environment });
  const backupList = JSON.parse(listedBackups.stdout);
  assert.equal(backupList.total, 2);
  assert.equal(backupList.metadataOnly, true);
  assert.deepEqual(backupList.items.map((item) => item.path).sort(), [removal.backup, recovery.backup].sort());
  const selectedBackup = backupList.items.find((item) => item.path === removal.backup);
  assert.equal(selectedBackup.status, "candidate");
  assert.equal(selectedBackup.restoreCommand[0], process.execPath);
  assert.equal(await realpath(selectedBackup.restoreCommand[1]), await realpath(join(installed, "dist", "index.js")));
  const listedPreview = await runCommand(selectedBackup.restoreCommand[0], selectedBackup.restoreCommand.slice(1), { cwd: directory, env: environment });
  assert.equal(JSON.parse(listedPreview.stdout).reason, "unchanged");
  const codex = await runCommand(executable, [...prefix, "connect", "codex", "--print"], { cwd: installation, env: environment });
  assert.ok(codex.stdout.includes("bearer_token_env_var"));
  assert.ok(!codex.stdout.includes(credentials.readToken));
  const cursor = await runCommand(executable, [...prefix, "connect", "cursor", "--print"], { cwd: installation, env: environment });
  const cursorSettings = JSON.parse(cursor.stdout).mcpServers.agent_tcdh;
  assert.equal(cursorSettings.command, process.execPath);
  assert.equal(await realpath(cursorSettings.args[0]), await realpath(join(installed, "dist", "index.js")));
  assert.equal(cursorSettings.env.AGENT_TCDH_READ_TOKEN, "${env:AGENT_TCDH_READ_TOKEN}");
  assert.ok(!cursor.stdout.includes(credentials.readToken));
  const local = await runCommand(executable, [...prefix, "target", "add", "--command", process.execPath,
    "--name", "Package stdio registration", "--dry-run"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(local.stdout).connection.transport, "stdio");
  const clientSource = join(directory, "source.jsonc");
  const sourceContents = "\uFEFF" + JSON.stringify({ mcpServers: { "packaged-local": { command: process.execPath } } });
  await writeFile(clientSource, sourceContents, "utf8");
  const importPreview = await runCommand(executable, [...prefix, "registry", "import-config", clientSource], { cwd: installation, env: environment });
  assert.equal(JSON.parse(importPreview.stdout).ready, true);
  assert.equal(JSON.parse(importPreview.stdout).applied, false);
  const presets = await runCommand(executable, [...prefix, "preset", "list"], { cwd: installation, env: environment });
  assert.ok(JSON.parse(presets.stdout).presets.some((preset) => preset.id === "public-docs"));
  const presetPreview = await runCommand(executable, [...prefix, "preset", "show", "public-docs", "--select", "openai-docs"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(presetPreview.stdout).targets.length, 1);
  assert.equal(JSON.parse(presetPreview.stdout).executionVerified, false);
  const marker = "package-" + randomUUID();
  await startServer();
  const initial = await verifyRuntime(url, credentials, marker);
  // Inspect/import foreign MCP and A2A declarations using an isolated home and project, with production YAML parsing.
  const localHome = join(directory, "foreign home");
  const localProject = join(directory, "foreign project");
  await mkdir(join(localProject, ".gemini", "agents"), { recursive: true });
  const foreignCommand = { command: process.execPath, args: [join(installed, "examples", "demo-targets.mjs"), "--stdio"] };
  await writeFile(join(localProject, ".mcp.json"), JSON.stringify({ mcpServers: { files: foreignCommand } }));
  await writeFile(join(localProject, ".gemini", "agents", "peer.md"), "---\nkind: remote\nname: peer\nagent_card_json: |\n  "
    + JSON.stringify({ name: "Peer", description: "Packaged inline card", url: "https://peer.example/tasks", protocolVersion: "0.3.0",
      preferredTransport: "JSONRPC", skills: [{ id: "research", description: "Research" }] }) + "\n---\n");
  const localImportArgs = [...prefix, "registry", "import-local", "--home", localHome, "--project", localProject];
  const discoveredLocal = await runCommand(executable, localImportArgs, { cwd: installation, env: environment });
  const localPlan = JSON.parse(discoveredLocal.stdout);
  assert.equal(localPlan.ready, true);
  assert.equal(localPlan.converted, 2);
  assert.equal(localPlan.metadataInspected, false);
  assert.equal(localPlan.executionVerified, false);
  const importedLocal = await runCommand(executable, [...localImportArgs, "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(importedLocal.stdout).result.inserted, 2);
  for (const target of localPlan.targets) {
    const saved = await runCommand(executable, [...prefix, "target", "get", target.id], { cwd: installation, env: environment });
    assert.equal(JSON.parse(saved.stdout).protocol, target.protocol);
    await runCommand(executable, [...prefix, "target", "remove", target.id], { cwd: installation, env: environment });
  }
  // Exercise the complete managed flow against private source/profile files; only local stdio metadata is inspected.
  const profilesFile = join(directory, "import profiles.json");
  const managedImport = await runCommand(executable, [...localImportArgs, "--select", "claude-code-project/files",
    "--save-profile", "fixture", "--profiles-file", profilesFile, "--apply", "--refresh", "--diagnose", "--inspect-stdio"],
    { cwd: installation, env: environment });
  const managedResult = JSON.parse(managedImport.stdout);
  assert.equal(managedResult.profileSaved, true);
  assert.equal(managedResult.followUp.failed, false);
  assert.ok(managedResult.followUp.outcomes[0].capabilities.names.includes("echo"));
  assert.ok(!(await readFile(profilesFile, "utf8")).includes(credentials.adminToken));
  const managedId = managedResult.targets[0].id;
  await writeFile(join(localProject, ".mcp.json"), JSON.stringify({ mcpServers: { files: { ...foreignCommand, disabled: true } } }));
  const syncArgs = [...prefix, "registry", "sync-local", "--profile", "fixture", "--profiles-file", profilesFile];
  const syncPreview = await runCommand(executable, syncArgs, { cwd: installation, env: environment });
  assert.equal(JSON.parse(syncPreview.stdout).plan.counts.updated, 1);
  assert.equal(JSON.parse(syncPreview.stdout).applied, false);
  const synced = await runCommand(executable, [...syncArgs, "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(synced.stdout).failed, false);
  const syncedTarget = await runCommand(executable, [...prefix, "target", "get", managedId], { cwd: installation, env: environment });
  assert.equal(JSON.parse(syncedTarget.stdout).enabled, false);
  assert.ok(JSON.parse(syncedTarget.stdout).capabilities.some((capability) => capability.name === "echo"));
  await writeFile(join(localProject, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  const pruned = await runCommand(executable, [...syncArgs, "--prune", "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(pruned.stdout).plan.counts.removed, 1);
  const profileRemoved = await runCommand(executable, [...prefix, "import-profile", "remove", "fixture", "--profiles-file", profilesFile, "--apply"],
    { cwd: installation, env: environment });
  assert.equal(JSON.parse(profileRemoved.stdout).registryChanged, false);

  const duplicateDefinition = join(directory, "duplicate.json");
  for (const id of ["package-keep", "package-remove"]) {
    await writeFile(duplicateDefinition, JSON.stringify({ id, name: id, description: "Packaged duplicate cleanup fixture", protocol: "mcp",
      connection: { transport: "stdio", command: process.execPath }, capabilities: [] }));
    await runCommand(executable, [...prefix, "target", "add", duplicateDefinition], { cwd: installation, env: environment });
  }
  const cleaned = await runCommand(executable, [...prefix, "registry", "duplicates", "--keep", "package-keep", "--remove", "package-remove", "--apply"],
    { cwd: installation, env: environment });
  assert.equal(JSON.parse(cleaned.stdout).outcomes[0].status, "removed");
  await runCommand(executable, [...prefix, "target", "remove", "package-keep"], { cwd: installation, env: environment });
  const imported = await runCommand(executable, [...prefix, "registry", "import-config", clientSource, "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(imported.stdout).applied, true);
  assert.equal(await readFile(clientSource, "utf8"), sourceContents);
  const presetImport = await runCommand(executable, [...prefix, "preset", "import", "public-docs", "--select", "openai-docs", "--prefix", "packaged", "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(presetImport.stdout).applied, true);
  const comparedConfig = await runCommand(executable, [...prefix, "registry", "import-config", clientSource, "--compare", "--on-conflict", "skip"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(comparedConfig.stdout).comparison.counts.unchanged, 1);
  assert.equal(JSON.parse(comparedConfig.stdout).applied, false);
  const comparedPreset = await runCommand(executable, [...prefix, "preset", "show", "public-docs", "--select", "openai-docs", "--prefix", "packaged", "--compare", "--on-conflict", "skip"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(comparedPreset.stdout).comparison.counts.unchanged, 1);
  const snapshotPath = join(directory, "comparison.json");
  await writeFile(snapshotPath, JSON.stringify({ format: "agent-tcdh", version: 1, exportedAt: new Date().toISOString(), targets: [] }), "utf8");
  const comparedSnapshot = await runCommand(executable, [...prefix, "registry", "diff", snapshotPath], { cwd: installation, env: environment });
  assert.equal(JSON.parse(comparedSnapshot.stdout).counts.retained, 4);
  assert.equal(JSON.parse(comparedSnapshot.stdout).applied, false);
  const doctor = await runCommand(executable, [...prefix, "doctor"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(doctor.stdout).status, "passed");
  assert.deepEqual(JSON.parse(doctor.stdout).runtime, identity);
  assert.equal(JSON.parse(doctor.stdout).executionVerified, false);
  const batchDoctor = await runCommand(executable, [...prefix, "doctor", "--all", "--q", "packaged-local", "--concurrency", "2"], { cwd: installation, env: environment });
  const batchReport = JSON.parse(batchDoctor.stdout);
  assert.equal(batchReport.batch.complete, true);
  assert.equal(batchReport.batch.matched, 1);
  assert.equal(batchReport.batch.summary.passed, 1);
  assert.equal(batchReport.batch.targets[0].metadata.scope, "none");
  assert.ok(batchReport.batch.targets[0].targetVersion);
  assert.equal(batchReport.batch.targets[0].executionVerified, false);

  // Verify actual metadata refresh through the installed CLI using only the isolated hub's MCP endpoint.
  const refreshDefinitionPath = join(directory, "refresh-target.json");
  await writeFile(refreshDefinitionPath, JSON.stringify({ id: "packaged-batch-refresh", name: "Packaged batch refresh",
    description: "Local metadata refresh verification", protocol: "mcp", tags: ["package-batch-refresh"], capabilities: [],
    connection: { transport: "streamable-http", url: url + "/mcp", auth: { type: "bearer", envVars: ["AGENT_TCDH_READ_TOKEN"] } } }), "utf8");
  await runCommand(executable, [...prefix, "target", "add", refreshDefinitionPath], { cwd: installation, env: environment });
  const batchRefreshArgs = [...prefix, "target", "refresh", "--all", "--tag", "package-batch-refresh"];
  const refreshPreview = await runCommand(executable, batchRefreshArgs, { cwd: installation, env: environment });
  assert.equal(JSON.parse(refreshPreview.stdout).summary.planned, 1);
  assert.equal(JSON.parse(refreshPreview.stdout).summary.updated, 0);
  const explicitDoctor = await runCommand(executable, [...prefix, "doctor", "--select", "packaged-batch-refresh", "--select", "packaged-local"], { cwd: installation, env: environment });
  const selectedDiagnosis = JSON.parse(explicitDoctor.stdout).batch;
  assert.equal(selectedDiagnosis.matched, 2);
  assert.equal(selectedDiagnosis.complete, true);
  assert.deepEqual(selectedDiagnosis.targets.map((target) => target.id), ["packaged-batch-refresh", "packaged-local"]);
  const explicitRefreshArgs = [...prefix, "target", "refresh", "--select", "packaged-batch-refresh", "--select", "packaged-local"];
  const explicitPreview = await runCommand(executable, explicitRefreshArgs, { cwd: installation, env: environment });
  assert.equal(JSON.parse(explicitPreview.stdout).summary.planned, 1);
  assert.equal(JSON.parse(explicitPreview.stdout).summary.skipped, 1);
  const refreshApplied = await runCommand(executable, [...explicitRefreshArgs, "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(refreshApplied.stdout).summary.updated, 1);
  const afterRefresh = await runCommand(executable, [...prefix, "target", "get", "packaged-batch-refresh", "--with-version"], { cwd: installation, env: environment });
  const unchangedRefresh = await runCommand(executable, [...explicitRefreshArgs, "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(unchangedRefresh.stdout).summary.unchanged, 1);
  const afterNoOp = await runCommand(executable, [...prefix, "target", "get", "packaged-batch-refresh", "--with-version"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(afterRefresh.stdout).etag, JSON.parse(afterNoOp.stdout).etag);
  await runCommand(executable, [...prefix, "target", "remove", "packaged-batch-refresh"], { cwd: installation, env: environment });

  const bridge = new StdioClientTransport({ command: cursorSettings.command, args: cursorSettings.args, cwd: directory,
    env: { AGENT_TCDH_READ_TOKEN: credentials.readToken, AGENT_TCDH_CONFIG: join(directory, "missing-config.json") }, stderr: "pipe" });
  const bridgeClient = new Client({ name: "package-client-profile", version: "1.0.0" });
  try {
    await bridgeClient.connect(bridge);
    assert.equal((await bridgeClient.listTools()).tools.length, 2);
    const discovered = await bridgeClient.callTool({ name: "get_target", arguments: { id: marker + "-mcp" } });
    assert.equal(discovered.isError, undefined);
    assert.equal(JSON.parse(discovered.content[0].text).id, marker + "-mcp");
  } finally {
    await bridgeClient.close();
    await bridge.close();
  }

  // 4. Verify JSON failure diagnostics for an unreachable metadata endpoint using the installed CLI.
  let diagnostic;
  try {
    await runCommand(executable, [...prefix, "target", "check", marker + "-mcp", "--hub", url,
      "--token-env", "AGENT_TCDH_READ_TOKEN"], { cwd: installation, env: environment });
    assert.fail("The unreachable test target must produce a failure report.");
  } catch (error) {
    assert.equal(error.code, 1);
    diagnostic = JSON.parse(error.stdout);
  }
  assert.equal(diagnostic.status, "failed");
  assert.equal(diagnostic.scope, "mcp-tools-list");
  assert.equal(diagnostic.executionVerified, false);

  const editPreview = await runCommand(executable, [...prefix, "target", "edit", "packaged-local", "--name", "Managed local connection", "--add-tag", "package-managed", "--dry-run"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(editPreview.stdout).applied, false);
  const edited = await runCommand(executable, [...prefix, "target", "edit", "packaged-local", "--name", "Managed local connection", "--add-tag", "package-managed", "--if-match", JSON.parse(editPreview.stdout).baseVersion], { cwd: installation, env: environment });
  assert.equal(JSON.parse(edited.stdout).applied, true);
  const disabled = await runCommand(executable, [...prefix, "target", "disable", "packaged-local"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(disabled.stdout).target.enabled, false);
  const unchanged = await runCommand(executable, [...prefix, "target", "disable", "packaged-local"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(unchanged.stdout).applied, false);
  const removalPreview = await runCommand(executable, [...prefix, "target", "remove", "packaged-local", "--dry-run"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(removalPreview.stdout).applied, false);

  // 5. Restart with the same database and verify registration and discovery again.
  await stopServer();
  await startServer();
  const restarted = await verifyRuntime(url, credentials, marker, true);
  for (const id of ["packaged-local", "packaged-openai-docs"]) {
    const persisted = await runCommand(executable, [...prefix, "target", "get", id], { cwd: installation, env: environment });
    assert.equal(JSON.parse(persisted.stdout).id, id);
  }

  const managed = await runCommand(executable, [...prefix, "target", "get", "packaged-local"], { cwd: installation, env: environment });
  const managedTarget = JSON.parse(managed.stdout);
  assert.equal(managedTarget.name, "Managed local connection");
  assert.ok(managedTarget.tags.includes("package-managed"));
  assert.equal(managedTarget.enabled, false);
  const enabled = await runCommand(executable, [...prefix, "target", "enable", "packaged-local"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(enabled.stdout).target.enabled, true);

  // 6. Run stdio and A2A direct-call examples with production dependencies only.
  const demo = await runCommand(process.execPath, [join(installed, "examples/local-demo.mjs"), "--discovery", "a2a"], {
    cwd: installation, env: environment,
  });
  const demoResult = JSON.parse(demo.stdout);
  assert.equal(demoResult.executions.length, 3);
  assert.ok(demoResult.executions.some((entry) => entry.transport === "stdio"));
  assert.equal(demoResult.remainingTargets.length, 2);
  console.log(JSON.stringify({ package: manifest.filename, isolatedProductionInstall: true,
    installedBinary: true, runtimeIdentity: true, onboarding: true, registryComparison: true, targetManagement: true, clientProfiles: true, clientDisconnection: true, configurationRestore: true, configurationBackups: true, batchDiagnostics: true, batchRefresh: true, explicitTargetSelection: true, configImport: true, localClientImport: true,
    importProfiles: true, sourceSynchronization: true, importFollowUp: true, stdioMetadata: true, duplicateCleanup: true,
    presets: true, documentation: true, targetDiagnostics: true, localDemo: true, initial, restarted, persistence: true }, null, 2));
} finally {
  // 7. Clean up only the processes and temporary files created by this run.
  try {
    await stopServer();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
