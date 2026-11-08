import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HubClient } from "./client.js";
import { PACKAGE_VERSION, runtimeInfo } from "./version.js";
import { searchSchema, targetDefinitionSchema, targetIdSchema } from "./targets/schema.js";
import { readClientToken } from "./auth.js";
import { a2aSelectionSchema } from "./targets/a2a.js";
import { loadConfig, consumerTokenEnv } from "./onboarding/config.js";
import { formatCommand, printOnboarding, targetTable } from "./onboarding/output.js";
import type { TargetDefinition } from "./targets/schema.js";
import type { ImportIssue } from "./onboarding/import-config.js";

const help = `AgentTCDH — Agent & Tool Capability Discovery Hub

Usage:
  agent-tcdh --version [--json]
  agent-tcdh hub-profile list|show|save|use|remove|clear [NAME] [--hub URL] [--apply]
                       [--hub-profiles-file FILE] [--token-env NAME] [--read-token-env NAME]
  agent-tcdh status [--hub-profile NAME] [--profiles-file FILE] [--stale-hours HOURS] [--limit COUNT]
  agent-tcdh setup [--client CLIENT] [--yes] [--apply] [--write FILE] [--replace]
                       [--select KEY ...] [--save-profile NAME] [--home DIR] [--project DIR]
  agent-tcdh import-profile edit NAME [--select KEY ... | --all-sources] [--project DIR]
                       [--source-path SOURCE_ID=PATH ...] [--profiles-file FILE] [--apply]
  agent-tcdh registry history [--target ID] [--before SEQUENCE] [--limit COUNT]
  agent-tcdh registry history show|undo SEQUENCE [--apply]
  agent-tcdh target freshness [--stale-hours HOURS] [--limit COUNT] [--offset COUNT]
  agent-tcdh target observe [--all | --select ID ...] [--stale-only] [--stale-hours HOURS]
                       [--apply] [--inspect-stdio] [--stdio-cwd DIR] [--limit COUNT]
  agent-tcdh init [--yes] [--config FILE] [--hub URL] [--host HOST] [--port PORT] [--db FILE]
  agent-tcdh connect <CLIENT> [--print | --write FILE | --check FILE] [--dry-run] [--replace]
                       CLIENT: codex, opencode, opencode-v1, claude-code, gemini-cli, cursor, vscode
  agent-tcdh disconnect <CLIENT> --file FILE [--name NAME] [--apply | --dry-run] [--normalize]
  agent-tcdh config backups --file FILE [--limit COUNT]
  agent-tcdh config restore <BACKUP_FILE> --file FILE [--apply | --dry-run]
  agent-tcdh doctor [--target ID | --all | --select ID ...] [--hub URL]
                       [--q QUERY] [--protocol mcp|a2a] [--tag TAG] [--include-disabled]
                       [--limit COUNT] [--concurrency COUNT]
  agent-tcdh target add <URL> [--protocol auto|mcp|a2a] [--id ID] [--dry-run]
  agent-tcdh target add --command COMMAND [--arg=ARG ...] [--env-var NAME ...] [--name NAME]
  agent-tcdh serve [--host HOST] [--port PORT] [--db FILE]
  agent-tcdh target add <JSON_FILE> [--hub URL]
  agent-tcdh target edit <ID> [--name NAME] [--description TEXT] [--add-tag TAG ...] [--remove-tag TAG ...]
                       [--dry-run] [--if-match ETAG] [--hub URL]
  agent-tcdh target enable|disable <ID> [--dry-run] [--if-match ETAG] [--hub URL]
  agent-tcdh target update <ID> <JSON_FILE> [--if-match ETAG] [--hub URL]
  agent-tcdh target import <URL> --id ID --protocol mcp|a2a [--dry-run] [--hub URL]
  agent-tcdh target refresh <ID> [--dry-run] [--hub URL]
  agent-tcdh target refresh --all [--apply | --dry-run] [--q QUERY] [--protocol mcp|a2a] [--tag TAG]
                       [--include-disabled] [--limit COUNT] [--concurrency COUNT] [--hub URL]
  agent-tcdh target refresh --select ID [--select ID ...] [--apply | --dry-run]
                       [--include-disabled] [--limit COUNT] [--concurrency COUNT] [--hub URL]
  agent-tcdh target check <ID> [--bearer-env VARIABLE] [--hub URL]
  agent-tcdh target get <ID> [--with-version] [--hub URL]
  agent-tcdh target list [--q QUERY] [--protocol mcp|a2a] [--tag TAG]
                       [--limit COUNT] [--offset OFFSET] [--include-disabled] [--hub URL]
  agent-tcdh target remove <ID> [--dry-run] [--if-match ETAG] [--hub URL]
  agent-tcdh import-profile list|show|remove [NAME] [--profiles-file FILE] [--apply]
  agent-tcdh registry sync-local --profile NAME [--profiles-file FILE] [--prune] [--apply]
                       [--refresh] [--diagnose] [--inspect-stdio] [--fetch-a2a-cards]
  agent-tcdh registry duplicates [--limit COUNT] [--keep ID --remove ID ...] [--apply]
  agent-tcdh target inspect-stdio <ID> [--apply] [--stdio-cwd DIR]
  agent-tcdh registry import-local [--client CLIENT ...] [--scope all|user|project] [--project DIR] [--home DIR]
                       [--select KEY ... | --interactive] [--profile NAME | --save-profile NAME]
                       [--prefix PREFIX] [--fetch-a2a-cards] [--apply | --compare]
                       [--refresh] [--diagnose] [--inspect-stdio] [--stdio-cwd DIR]
  agent-tcdh registry import-config <FILE> [--format FORMAT] [--select NAME ...] [--prefix PREFIX] [--apply | --compare] [--details]
  agent-tcdh preset list
  agent-tcdh preset show <NAME> [--select ID ...] [--compare] [--details]
  agent-tcdh preset import <NAME> [--select ID ...] [--prefix PREFIX] [--apply | --compare] [--details]
  agent-tcdh registry diff <JSON_FILE> [--on-conflict error|skip|replace] [--details] [--hub URL]
  agent-tcdh registry export <JSON_FILE> [--overwrite] [--hub URL]
  agent-tcdh registry import <JSON_FILE> [--on-conflict error|skip|replace] [--dry-run] [--hub URL]
  agent-tcdh mcp [--hub URL] [--no-config] [--anonymous | --token-env VARIABLE]

Environment:
  HOST                  Listener address (default: 127.0.0.1)
  PORT                  Listener port (default: 3000)
  AGENT_TCDH_DB_PATH     SQLite file (default: ~/.agent-tcdh/registry.sqlite)
  AGENT_TCDH_CONFIG      Optional setup configuration path (default: ~/.agent-tcdh/config.json)
  AGENT_TCDH_URL         Hub URL for CLI and MCP (default: http://127.0.0.1:3000)
  AGENT_TCDH_TOKEN       Optional administrator Bearer token; default CLI/MCP credential
  AGENT_TCDH_READ_TOKEN  Optional read-only token accepted by the server
  AGENT_TCDH_ALLOWED_ORIGINS  Comma-separated allowed origins for HTTP MCP and A2A
  AGENT_TCDH_PUBLIC_URL  Public base URL advertised in the A2A card behind proxies/containers

Options:
  --help, -h            Show usage
  --version, -v         Print the package version; --json includes local runtime identity
  --compare             Compare a config/preset preview with current hub metadata (read-only)
  --details             Include full definitions and print JSON comparison output
  --apply               Apply an import, batch refresh, disconnection, or config restore; previews are the default
  --interactive         Choose local connections with terminal checkboxes; no entries are preselected
  --profile NAME        Reuse a private import profile and its recorded hub
  --save-profile NAME   Save source locations/selectors and track any successful initial import
  --profiles-file FILE  Select private import-profile storage
  --prune               Include unchanged source removals in a sync plan; --apply performs them
  --refresh             Refresh metadata after an applied local import/synchronization
  --diagnose            Diagnose metadata after an applied local import/synchronization
  --inspect-stdio       Explicitly authorize local stdio process startup for metadata collection
  --stdio-cwd DIR       Working directory for explicitly authorized stdio metadata processes
  --keep ID             Preserve this representative during duplicate cleanup
  --remove ID           Select a duplicate to remove; repeat for an explicit group
  --client CLIENT       Limit local import to named clients; repeat to choose several
  --scope SCOPE         Local import sources: all (default), user, or project
  --project DIR         Inspect this exact project directory (default: current directory)
  --home DIR            Inspect this user home instead of native defaults and environment path overrides
  --fetch-a2a-cards     Allow up to 10 selected A2A card metadata lookups; no tasks are executed
  --format FORMAT       Client config format: auto, codex, opencode, opencode-v1, mcp-json
  --select NAME         Repeat for local entry keys, source server names, preset IDs, or doctor/refresh IDs
  --prefix PREFIX       Namespace imported target ids
  --no-config           Ignore setup files for an explicitly configured stdio discovery bridge
  --anonymous           Use anonymous hub access for mcp; never resolve credential variables
  --config FILE         Use setup defaults; flags override environment, then configuration
  --json                Print JSON, including in a terminal; redirected output defaults to JSON
  --remote              Initialize client settings for an existing hub
  --yes                 Initialize without prompts, using supplied options and defaults
  --force               Replace setup configuration with an exact backup
  --read-token-env NAME  Record the read credential environment name during setup
  --print               Print only the generated client configuration fragment
  --check FILE          Check a saved client profile without writes or network calls
  --file FILE           Select the destination for disconnect or config management
  --normalize           Allow TOML normalization during disconnect, with an exact backup
  --write FILE          Merge the hub into this explicit client file, preserving a backup
  --replace             Replace a conflicting named hub entry in a client configuration
  --all                 Select all matching targets for doctor or refresh (default limit: 100)
  --concurrency COUNT   Parallel doctor/refresh inspections, 1–8 (default: 3)
  --limit COUNT         Result limit; config backups defaults to 20, maximum 100
  --target ID           Inspect this target's metadata and local prerequisites during doctor
  --command COMMAND     Register a local MCP stdio command without executing it
  --arg ARG             Repeat for each literal stdio argument; use --arg=--flag for flags
  --env-var NAME        Declare a consumer-side environment variable, without storing its value
  --add-tag TAG         Repeat to append a tag during target edit
  --remove-tag TAG      Repeat to remove a tag during target edit
  --name NAME          Set a target display name; connect/disconnect use a server entry name
  --description TEXT   Set a target description
  --transport TYPE     MCP import transport: streamable-http or sse
  --a2a-binding TYPE   Select JSONRPC or HTTP+JSON
  --a2a-version VERSION  Select a declared A2A protocol version
  --bearer-env VARIABLE  Environment variable containing the remote Bearer token
  --dry-run            Preview supported changes without writing registry/client files
  --on-conflict POLICY  Bulk import conflict policy (default: error)
  --overwrite          Allow replacement of an existing export file
  --with-version       Include the target ETag in lookup output
  --if-match ETAG      Require a matching version for updates or deletion
  --token-env VARIABLE  CLI/stdio MCP credential variable (default: AGENT_TCDH_TOKEN)

The default command is serve. Administrative results are printed as JSON.
`;

/** Validate commands and options before dispatching to the server, registry API, or MCP discovery. */
export async function runCli(args: string[]): Promise<void> {
  // 1. Parse shared options and handle help or local version requests.
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      config: { type: "string" },
      "no-config": { type: "boolean" },
      anonymous: { type: "boolean" },
      apply: { type: "boolean" },
      compare: { type: "boolean" },
      details: { type: "boolean" },
      format: { type: "string" },
      client: { type: "string", multiple: true },
      scope: { type: "string" },
      project: { type: "string" },
      home: { type: "string" },
      "fetch-a2a-cards": { type: "boolean" },
      interactive: { type: "boolean" },
      profile: { type: "string" },
      "save-profile": { type: "string" },
      "profiles-file": { type: "string" },
      "hub-profile": { type: "string" },
      "hub-profiles-file": { type: "string" },
      "all-sources": { type: "boolean" },
      "source-path": { type: "string", multiple: true },
      "stale-hours": { type: "string" },
      "stale-only": { type: "boolean" },
      before: { type: "string" },
      prune: { type: "boolean" },
      refresh: { type: "boolean" },
      diagnose: { type: "boolean" },
      "inspect-stdio": { type: "boolean" },
      "stdio-cwd": { type: "string" },
      keep: { type: "string" },
      remove: { type: "string", multiple: true },
      select: { type: "string", multiple: true },
      prefix: { type: "string" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      remote: { type: "boolean" },
      force: { type: "boolean" },
      "read-token-env": { type: "string" },
      print: { type: "boolean" },
      write: { type: "string" },
      file: { type: "string" },
      normalize: { type: "boolean" },
      check: { type: "string" },
      replace: { type: "boolean" },
      target: { type: "string" },
      all: { type: "boolean" },
      concurrency: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      "env-var": { type: "string", multiple: true },
      host: { type: "string" },
      port: { type: "string" },
      db: { type: "string" },
      hub: { type: "string" },
      q: { type: "string" },
      protocol: { type: "string" },
      tag: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      "include-disabled": { type: "boolean" },
      id: { type: "string" },
      name: { type: "string" },
      "add-tag": { type: "string", multiple: true },
      "remove-tag": { type: "string", multiple: true },
      description: { type: "string" },
      transport: { type: "string" },
      "bearer-env": { type: "string" },
      "dry-run": { type: "boolean" },
      "on-conflict": { type: "string" },
      overwrite: { type: "boolean" },
      "token-env": { type: "string" },
      "with-version": { type: "boolean" },
      "if-match": { type: "string" },
      "a2a-binding": { type: "string" },
      "a2a-version": { type: "string" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }

  if (values.version) {
    if (positionals.length || Object.keys(values).some((key) => !["version", "json"].includes(key))) {
      throw new Error("Use --version by itself, with optional --json.");
    }
    if (values.json) {
      printJson(runtimeInfo());
    } else {
      process.stdout.write(PACKAGE_VERSION + "\n");
    }
    return;
  }

  // 2. Prepare first-run configuration without loading a file that does not exist yet.
  const command = positionals[0] ?? "serve";
  if ((values["no-config"] || values.anonymous) && command !== "mcp"
    || values["no-config"] && values.config || values.anonymous && values["token-env"]) {
    throw new Error("--no-config and --anonymous are mcp-only options. Do not combine --no-config with --config, or --anonymous with --token-env.");
  }
  if (command === "init") {
    validateArguments(positionals, 1, values, ["config", "json", "yes", "remote", "force", "hub", "host", "port", "db", "token-env", "read-token-env"]);
    const { initialize } = await import("./onboarding/init.js");
    const result = await initialize({ config: values.config, yes: values.yes, remote: values.remote, force: values.force,
      hub: values.hub, host: values.host, port: values.port, db: values.db,
      tokenEnv: values["token-env"], readTokenEnv: values["read-token-env"],
    });
    printOnboarding(result, values.json, () => "Configuration saved: " + result.path + "\nHub: " + result.hub
      + (result.backup ? "\nBackup: " + result.backup : "")
      + (result.credentialEnvironmentVariables.length ? "\nSet these environment variables before starting: " + result.credentialEnvironmentVariables.join(", ") : result.mode === "local" ? "\nLocal setup without explicit credential references; configure tokens before sharing the listener." : "\nExisting hub selected; configure its credential references if required.")
      + "\nNext commands" + (result.mode === "local" ? " (run serve in another terminal)" : "") + ":\n"
      + result.nextCommands.map((args) => formatCommand(args)).join("\n"));
    return;
  }
  if (command === "disconnect") {
    validateArguments(positionals, 2, values, ["file", "name", "apply", "dry-run", "normalize"]);
    if (values.config !== undefined || values.file === undefined || values.apply && values["dry-run"]) {
      throw new Error("Use disconnect CLIENT --file FILE with optional --name, --normalize, --json, and either --apply or --dry-run. Setup configuration is not used.");
    }
    const { disconnectClient } = await import("./onboarding/disconnect.js");
    const result = await disconnectClient({ client: positionals[1]!, file: values.file, name: values.name,
      apply: values.apply, normalize: values.normalize });
    printOnboarding(result, values.json, () => result.reason.toUpperCase() + ": " + JSON.stringify(result.path)
      + "\nNamed entry: " + result.name
      + (result.backup ? "\nBackup: " + JSON.stringify(result.backup) : "")
      + (result.notes.length ? "\n" + result.notes.join("\n") : "") + "\n" + result.instructions);
    process.exitCode = result.ready ? 0 : 1;
    return;
  }
  if (command === "config") {
    if (positionals[1] === "backups") {
      validateArguments(positionals, 2, values, ["file", "limit"]);
      if (values.config !== undefined || values.file === undefined) {
        throw new Error("Use config backups --file FILE with optional --limit and --json. Setup defaults are not used.");
      }
      const { listConfigBackups, formatBackupList } = await import("./onboarding/backups.js");
      const result = await listConfigBackups({ file: values.file, limit: values.limit === undefined ? undefined : Number(values.limit) });
      printOnboarding(result, values.json, () => formatBackupList(result));
      return;
    }
    if (positionals[1] !== "restore") {
      throw new Error("Unknown configuration command. Run --help for usage.");
    }
    validateArguments(positionals, 3, values, ["file", "apply", "dry-run"]);
    if (values.config !== undefined || values.file === undefined || values.apply && values["dry-run"]) {
      throw new Error("Use config restore BACKUP_FILE --file FILE with optional --json and either --apply or --dry-run. Setup defaults are not used.");
    }
    const { restoreConfig } = await import("./onboarding/restore.js");
    const result = await restoreConfig({ source: positionals[2]!, file: values.file, apply: values.apply });
    printOnboarding(result, values.json, () => result.reason.toUpperCase() + ": " + JSON.stringify(result.path)
      + "\nSource: " + JSON.stringify(result.source)
      + "\nBytes: " + (result.destinationBytes ?? "missing") + " -> " + result.sourceBytes
      + (result.backup ? "\nBackup of previous file: " + JSON.stringify(result.backup) : "")
      + "\n" + result.instructions);
    return;
  }
  if (command === "hub-profile") {
    const action = positionals[1] ?? "";
    validateArguments(positionals, ["list", "clear"].includes(action) ? 2 : 3, values,
      ["hub-profiles-file", ...(["list", "show"].includes(action) ? [] : ["apply"]),
        ...(action === "save" ? ["hub", "token-env", "read-token-env"] : [])]);
    if (values.config !== undefined) {
      throw new Error("Hub-profile management uses --hub-profiles-file, not --config.");
    }
    const { manageHubProfile } = await import("./onboarding/hub-profiles.js");
    if (values["hub-profile"]) {
      throw new Error("Hub-profile management does not accept --hub-profile.");
    }
    const result = await manageHubProfile(action, positionals[2], values["hub-profiles-file"],
      { hub: values.hub, tokenEnv: values["token-env"], readTokenEnv: values["read-token-env"] }, values.apply);
    printJson(result);
    return;
  }
  if (command === "import-profile") {
    const action = positionals[1];
    if (!["list", "show", "remove", "edit"].includes(action ?? "")) {
      throw new Error("Use import-profile list, show NAME, edit NAME, or remove NAME.");
    }
    validateArguments(positionals, action === "list" ? 2 : 3, values, ["profiles-file", ...(action === "remove" ? ["apply"] : []),
      ...(action === "edit" ? ["select", "all-sources", "project", "source-path", "apply"] : [])]);
    if (values.config !== undefined) {
      throw new Error("Import-profile management does not use hub setup. Select --profiles-file instead.");
    }
    const { readImportProfiles, importProfileNameSchema, mutateImportProfiles } = await import("./onboarding/import-profiles.js");
    const loaded = await readImportProfiles(values["profiles-file"]);
    if (action === "list") {
      const profiles = Object.entries(loaded.store.profiles).map(([name, profile]) => ({ name, hub: profile.hub, project: profile.project, managed: profile.bindings.length }));
      printOnboarding({ path: loaded.path, profiles }, values.json, () => profiles.map((profile) => JSON.stringify(profile.name) + " " + profile.managed + " managed; " + JSON.stringify(profile.hub)).join("\n") || "No saved import profiles.");
      return;
    }
    const name = importProfileNameSchema.parse(positionals[2]);
    if (!Object.hasOwn(loaded.store.profiles, name)) {
      throw new Error("Import profile not found.");
    }
    if (action === "edit") {
      const { editImportProfile } = await import("./onboarding/import-profile-edit.js");
      const result = await editImportProfile(name, loaded.path, { select: values.select, allSources: values["all-sources"],
        project: values.project, sourcePaths: values["source-path"], apply: values.apply });
      printJson(result);
      process.exitCode = result.ready ? 0 : 1;
      return;
    }
    if (action === "show") {
      printJson({ path: loaded.path, name, profile: loaded.store.profiles[name] });
      return;
    }
    if (values.apply) {
      await mutateImportProfiles(values["profiles-file"], async (store) => {
        if (!Object.hasOwn(store.profiles, name)) {
          throw new Error("Import profile changed before removal.");
        }
        delete store.profiles[name];
        return { result: undefined, save: true };
      });
    }
    printOnboarding({ path: loaded.path, name, removed: Boolean(values.apply), registryChanged: false }, values.json,
      () => JSON.stringify(name) + (values.apply ? " profile removed." : " removal preview; use --apply.") + " Registry registrations are retained.");
    return;
  }
  const boundProfile = command === "registry" && ["import-local", "sync-local"].includes(positionals[1] ?? "") && values.profile
    ? await (await import("./onboarding/import-profiles.js")).readImportProfile(values.profile, values["profiles-file"]) : undefined;
  if (values["hub-profile"] && (boundProfile || values.config || values["no-config"] || command === "serve")) {
    throw new Error("An explicit hub profile cannot override an import profile, --config, --no-config, or serve.");
  }
  const useHubProfiles = values["hub-profile"] !== undefined || !boundProfile && !values.config && !values["no-config"]
    && !values.hub && !process.env.AGENT_TCDH_URL && command !== "serve";
  const selectedHub = useHubProfiles
    ? await (await import("./onboarding/hub-profiles.js")).resolveHubProfile(values["hub-profile"], values["hub-profiles-file"]) : undefined;
  if (selectedHub && values.hub && (await import("./onboarding/config.js")).normalizeHub(values.hub) !== selectedHub.hub) {
    throw new Error("Explicit --hub conflicts with the selected hub profile.");
  }
  const loadedConfig = values["no-config"] || (boundProfile || selectedHub) && values.config === undefined ? undefined : await loadConfig(values.config);
  const config = selectedHub ? { formatVersion: 1 as const, mode: "remote" as const, hub: selectedHub.hub,
    server: { host: "127.0.0.1", port: 3000, dbPath: "registry.sqlite" },
    ...(selectedHub.tokenEnv ? { tokenEnv: selectedHub.tokenEnv } : {}),
    ...(selectedHub.readTokenEnv ? { readTokenEnv: selectedHub.readTokenEnv } : {}) } : loadedConfig;
  const hub = values.hub ?? boundProfile?.hub ?? selectedHub?.hub ?? process.env.AGENT_TCDH_URL ?? config?.hub ?? "http://127.0.0.1:3000";
  const consumerReference = values["token-env"] ?? consumerTokenEnv(config, selectedHub ? {} : process.env);
  if (command === "status") {
    validateArguments(positionals, 1, values, ["hub", "profiles-file", "stale-hours", "limit"]);
    const { freshnessQuerySchema } = await import("./registry/activity.js");
    const selection = freshnessQuerySchema.parse({ staleHours: values["stale-hours"], limit: values.limit ?? 1000 });
    const { managementStatus } = await import("./onboarding/status.js");
    const result = await managementStatus({ hub, tokenEnv: consumerReference, profilesFile: values["profiles-file"],
      staleHours: selection.staleHours, limit: selection.limit, hubProfile: selectedHub?.name },
      selectedHub && !consumerReference ? { ...process.env, AGENT_TCDH_TOKEN: undefined } : process.env);
    printOnboarding(result, values.json, () => "Hub: " + JSON.stringify(result.hub)
      + "\n" + result.checks.map((check) => check.status.toUpperCase() + " " + check.section + ": " + check.message).join("\n")
      + ("counts" in result && result.counts ? "\nRegistrations: " + result.counts.total + " (" + result.counts.enabled + " enabled, " + result.counts.disabled + " disabled)" : "")
      + ("profiles" in result ? "\n" + result.profiles.map((profile) => "Source profile " + JSON.stringify(profile.name) + ": " + profile.status
        + (profile.changes ? " " + JSON.stringify(profile.changes) : " " + profile.issue)).join("\n") : "")
      + ("variables" in result ? "\n" + result.variables.map((variable) => (variable.available ? "AVAILABLE " : "MISSING ") + variable.name).join("\n") : "")
      + ("freshness" in result && result.freshness ? "\nMetadata: " + result.freshness.items.map((item) => item.id + " " + item.state + "/" + item.status).join(", ") : "")
      + "\nNo target providers contacted; execution not verified.");
    process.exitCode = result.failed ? 1 : 0;
    return;
  }

  // 3. Generate consumer settings and run read-only diagnostics before requiring administration credentials.
  if (command === "connect") {
    validateArguments(positionals, 2, values, ["hub", "print", "write", "check", "dry-run", "replace", "name"]);
    if (values.check !== undefined && (values.print || values.write !== undefined || values["dry-run"] || values.replace)) {
      throw new Error("Use --check FILE alone with optional --hub, --token-env, --name, --config, or --json.");
    }
    if (values.check !== undefined) {
      const { checkConnection } = await import("./onboarding/connect.js");
      const result = await checkConnection({ client: positionals[1]!, hub, file: values.check,
        tokenEnv: consumerReference, name: values.name });
      printOnboarding(result, values.json, () => result.status.toUpperCase() + " " + result.reason + ": " + JSON.stringify(result.path)
        + (result.differingFields.length ? "\nDiffering fields: " + result.differingFields.join(", ") : "")
        + "\n" + result.action + "\n" + result.scope);
      process.exitCode = result.status === "passed" ? 0 : 1;
      return;
    }
    if (values.print && values.write || values.print && values.json || (values["dry-run"] || values.replace) && !values.write) {
      throw new Error("Use --print alone, or --write FILE with optional --dry-run. --print cannot be combined with --json.");
    }
    const { connectClient } = await import("./onboarding/connect.js");
    const result = await connectClient({ client: positionals[1]!, hub,
      tokenEnv: consumerReference, write: values.write,
      replace: values.replace, name: values.name, dryRun: values["dry-run"],
    });
    if (values.print) {
      process.stdout.write(result.content!);
    } else {
      printOnboarding(result, values.json, () => (result.content ?? "Configuration saved: " + result.path)
        + ("backup" in result && result.backup ? "\nBackup: " + result.backup : "")
        + "\n" + result.notes.join("\n") + "\n" + result.instructions
        + (result.requiredEnvironmentVariables.length ? "\nRequired in the client environment: " + result.requiredEnvironmentVariables.join(", ") : ""));
    }
    return;
  }
  if (command === "doctor") {
    validateArguments(positionals, 1, values, ["hub", "target", "all", "select", "q", "protocol", "tag", "include-disabled", "limit", "concurrency"]);
    const explicit = values.select !== undefined;
    if (Number(Boolean(values.target)) + Number(Boolean(values.all)) + Number(explicit) > 1
      || !values.all && !explicit && ["q", "protocol", "tag", "include-disabled", "limit", "concurrency"].some((key) => values[key as keyof typeof values] !== undefined)
      || explicit && ["q", "protocol", "tag"].some((key) => values[key as keyof typeof values] !== undefined)) {
      throw new Error("Choose --target, --all, or repeated --select IDs. Discovery filters require --all; batch resource options require --all or --select.");
    }
    const { batchDiagnosisOptionsSchema } = await import("./onboarding/doctor-batch.js");
    const batch = values.all || explicit ? batchDiagnosisOptionsSchema.parse({ select: values.select, q: values.q, protocol: values.protocol, tag: values.tag,
      includeDisabled: values["include-disabled"], limit: values.limit === undefined ? undefined : Number(values.limit),
      concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency) }) : undefined;
    const { diagnose } = await import("./onboarding/doctor.js");
    const result = await diagnose({ hub, tokenEnv: consumerReference, target: values.target === undefined ? undefined : targetIdSchema.parse(values.target), batch },
      selectedHub && !consumerReference ? { ...process.env, AGENT_TCDH_TOKEN: undefined, AGENT_TCDH_READ_TOKEN: undefined } : process.env);
    printOnboarding(result, values.json, () => "AgentTCDH " + result.runtime.version + " | Node.js " + result.runtime.node
      + " | " + result.runtime.platform + "/" + result.runtime.arch + "\n"
      + result.checks.map((check) => check.status.toUpperCase() + " " + check.id + ": " + check.message
      + (check.status !== "passed" && check.action ? "\n  Next: " + check.action : "")).join("\n")
      + (result.batch ? "\n" + result.batch.targets.map((target) => target.status.toUpperCase() + " " + target.id + " (" + target.transport + ")\n"
        + target.checks.map((check) => "  " + check.status.toUpperCase() + " " + check.id + ": " + check.message
          + (check.status !== "passed" && check.action ? "\n    Next: " + check.action : "")).join("\n")).join("\n") : "")
      + "\nExecution verification: not performed.");
    process.exitCode = result.status === "failed" ? 1 : 0;
    return;
  }

  // 4. Apply server options using flags, environment, setup configuration, then built-in defaults.
  if (command === "serve") {
    validateArguments(positionals, positionals.length === 0 ? 0 : 1, values, ["host", "port", "db"]);
    if (config?.mode === "remote") {
      throw new Error("This configuration connects to an existing hub. Initialize a local setup configuration to run serve.");
    }
    const { runServer, serverOptionsSchema } = await import("./server.js");
    await runServer(serverOptionsSchema.parse({
      host: values.host ?? process.env.HOST ?? config?.server.host ?? "127.0.0.1",
      port: values.port ?? process.env.PORT ?? config?.server.port ?? "3000",
      dbPath: values.db ?? process.env.AGENT_TCDH_DB_PATH ?? config?.server.dbPath,
      token: readClientToken(config?.tokenEnv, config?.tokenEnv !== undefined),
      readToken: readClientToken(config?.readTokenEnv ?? "AGENT_TCDH_READ_TOKEN", config?.readTokenEnv !== undefined),
      publicUrl: process.env.AGENT_TCDH_PUBLIC_URL || undefined,
      allowedOrigins: (process.env.AGENT_TCDH_ALLOWED_ORIGINS ?? "")
        .split(",").map((origin) => origin.trim()).filter(Boolean),
    }));
    return;
  }

  // 5. Share the authenticated registry API with existing CLI and MCP commands.
  if (!["mcp", "target", "registry", "preset", "setup"].includes(command)) {
    throw new Error("Unknown command. Run --help for usage.");
  }
  const metadataPreview = !values.compare && (command === "setup" && !values.apply || command === "target" && ["add", "import"].includes(positionals[1] ?? "") && values["dry-run"]
    || command === "registry" && ["import-config", "import-local"].includes(positionals[1] ?? "") && !values.apply
    || command === "preset" && (positionals[1] !== "import" || !values.apply));
  const readCommand = command === "registry" && (["sync-local", "duplicates"].includes(positionals[1] ?? "") && !values.apply || positionals[1] === "diff" || ["import-config", "import-local"].includes(positionals[1] ?? "") && values.compare)
    || command === "preset" && ["show", "import"].includes(positionals[1] ?? "") && values.compare
    || command === "mcp" || command === "target" && (positionals[1] === "inspect-stdio" && !values.apply || ["list", "get", "check", "freshness"].includes(positionals[1] ?? "")
    || positionals[1] === "observe" && !values.apply
    || positionals[1] === "refresh" && (values.all || values.select !== undefined) && !values.apply
    || ["refresh", "edit", "enable", "disable", "remove"].includes(positionals[1] ?? "") && values["dry-run"]);
  const credentialDefaults = boundProfile ?? config;
  if (!readCommand && !metadataPreview && !values["token-env"] && credentialDefaults?.readTokenEnv && !credentialDefaults.tokenEnv
    && (boundProfile !== undefined || selectedHub !== undefined || !process.env.AGENT_TCDH_TOKEN)) {
    throw new Error("This setup has only read credentials. Select an administrator credential with --token-env for mutations.");
  }
  const clientTokenEnv = values["token-env"] ?? (metadataPreview ? undefined : readCommand ? credentialDefaults?.readTokenEnv ?? credentialDefaults?.tokenEnv : credentialDefaults?.tokenEnv);
  const client = new HubClient(hub, values.anonymous || selectedHub && !clientTokenEnv || metadataPreview && values["token-env"] === undefined ? undefined
    : readClientToken(clientTokenEnv, clientTokenEnv !== undefined));
  if (command === "setup") {
    validateArguments(positionals, 1, values, ["hub", "client", "yes", "apply", "write", "replace", "select", "save-profile", "profiles-file", "home", "project", "scope"]);
    if (values.client && values.client.length !== 1 || values.replace && !values.write) {
      throw new Error("Setup takes exactly one consumer --client; --replace requires an explicit --write FILE.");
    }
    const { setupConsumer } = await import("./onboarding/setup.js");
    const result = await setupConsumer(client, hub, { client: values.client?.[0], yes: values.yes, apply: values.apply,
      write: values.write, replace: values.replace, select: values.select, saveProfile: values["save-profile"],
      profilesFile: values["profiles-file"], home: values.home, project: values.project, scope: values.scope as "user" | "project" | "all" | undefined,
      tokenEnv: values["token-env"] ?? config?.tokenEnv, readTokenEnv: config?.readTokenEnv });
    printOnboarding(result, values.json, () => (result.applied ? "Setup applied." : "cancelled" in result ? "Setup cancelled." : "Setup preview; no changes applied.")
      + ("registration" in result ? "\nSelected connections: " + result.registration.entries.filter((entry) => entry.selected).map((entry) => JSON.stringify(entry.key)).join(", ") : "")
      + ("connection" in result && result.connection ? "\n" + (result.connection.content ?? "Client settings prepared: " + result.connection.path) + "\n" + result.connection.instructions : "")
      + ("next" in result ? "\n" + result.next : ""));
    process.exitCode = result.ready && !("failed" in result && result.failed) ? 0 : 1;
    return;
  }
  if (command === "registry" && positionals[1] === "history") {
    const { historyIdSchema, historyQuerySchema } = await import("./registry/activity.js");
    const action = positionals[2];
    if (action === undefined) {
      validateArguments(positionals, 2, values, ["hub", "target", "before", "limit"]);
      printJson(await client.history(historyQuerySchema.parse({ target: values.target, before: values.before, limit: values.limit })));
    } else if (action === "show" || action === "undo") {
      validateArguments(positionals, 4, values, ["hub", ...(action === "undo" ? ["apply"] : [])]);
      const id = historyIdSchema.parse(positionals[3]);
      const result = action === "show" ? await client.historyEvent(id) : await client.undoHistory(id, Boolean(values.apply));
      printJson(result);
      if ("ready" in result && !result.ready) {
        process.exitCode = 1;
      }
    } else {
      throw new Error("Use registry history, history show SEQUENCE, or history undo SEQUENCE [--apply].");
    }
    return;
  }
  if (command === "target" && positionals[1] === "freshness") {
    validateArguments(positionals, 2, values, ["hub", "stale-hours", "limit", "offset"]);
    const { freshnessQuerySchema } = await import("./registry/activity.js");
    const result = await client.freshness(freshnessQuerySchema.parse({ staleHours: values["stale-hours"], limit: values.limit, offset: values.offset }));
    printOnboarding(result, values.json, () => result.items.map((item) => item.id + " " + item.state.toUpperCase() + " " + item.status
      + " | last checked: " + (item.checkedAt ?? "never")).join("\n") + "\n" + result.items.length + "/" + result.total + " shown; offset " + result.offset + ". Consumer reports only; execution not verified.");
    return;
  }
  if (command === "target" && positionals[1] === "observe") {
    validateArguments(positionals, 2, values, ["hub", "all", "select", "q", "protocol", "tag", "include-disabled", "limit", "apply", "stale-only", "stale-hours", "inspect-stdio", "stdio-cwd", "refresh"]);
    if (Boolean(values.all) === Boolean(values.select) || values["stdio-cwd"] && !values["inspect-stdio"]
      || (values["inspect-stdio"] || values.refresh) && !values.apply) {
      throw new Error("Choose --all or --select ID. Stdio inspection requires --apply; --stdio-cwd requires --inspect-stdio.");
    }
    const { batchTargetOptionsSchema } = await import("./targets/batch.js");
    const { observeTargets } = await import("./targets/observe.js");
    const result = await observeTargets(client, batchTargetOptionsSchema.parse({ select: values.select, q: values.q, protocol: values.protocol,
      tag: values.tag, includeDisabled: values["include-disabled"], limit: values.limit === undefined ? undefined : Number(values.limit) }),
      { apply: values.apply, staleOnly: values["stale-only"], staleHours: values["stale-hours"] === undefined ? undefined : Number(values["stale-hours"]),
        inspectStdio: values["inspect-stdio"], stdioCwd: values["stdio-cwd"], refresh: values.refresh });
    printJson(result);
    process.exitCode = result.failed ? 1 : 0;
    return;
  }
  if (command === "mcp") {
    validateArguments(positionals, 1, values, ["hub", "no-config", "anonymous"]);
    const { runDiscoveryServer } = await import("./mcp.js");
    await runDiscoveryServer(client);
    return;
  }
  if (command === "preset") {
    const action = positionals[1];
    const { listPresets, preparePreset } = await import("./onboarding/presets.js");
    if (action === "list") {
      validateArguments(positionals, 2, values, []);
      const presets = await listPresets();
      printOnboarding({ presets }, values.json, () => presets.map((preset) => preset.id + ": " + preset.targets + " targets\n  " + preset.description
        + "\n  Select: " + preset.targetIds.join(", ") + "\n  Metadata as of: " + preset.metadataAsOf).join("\n"));
      return;
    }
    if (action === "show" || action === "import") {
      validateArguments(positionals, 3, values, action === "show" ? ["select", "prefix", "hub", "compare", "details", "on-conflict"] : ["hub", "select", "prefix", "apply", "dry-run", "on-conflict", "compare", "details"]);
      if (values.apply && (values["dry-run"] || values.compare) || values.details && !values.compare) {
        throw new Error("Choose either --apply or a preview (--compare/--dry-run). --details requires --compare.");
      }
      const preparation = await preparePreset(positionals[2]!, { select: values.select, prefix: values.prefix });
      await finishPreparedImport(preparation, client, action === "import" && Boolean(values.apply), values["on-conflict"], values.json, values.compare, values.details);
      return;
    }
    throw new Error("Unknown preset command. Run preset list or --help.");
  }
  if (command === "registry") {
    const action = positionals[1];
    if (action === "diff") {
      validateArguments(positionals, 3, values, ["hub", "on-conflict", "details"]);
      const { readSnapshot } = await import("./registry/files.js");
      const { compareRegistry, formatComparison } = await import("./registry/diff.js");
      const report = await compareRegistry(client, await readSnapshot(positionals[2]!), { onConflict: values["on-conflict"], details: values.details });
      printOnboarding(report, values.json || values.details, () => formatComparison(report));
      return;
    }
    if (action === "import-local") {
      validateArguments(positionals, 2, values, ["hub", "client", "scope", "project", "home", "select", "prefix", "fetch-a2a-cards", "apply", "dry-run", "on-conflict", "compare", "details",
        "interactive", "profile", "save-profile", "profiles-file", "refresh", "diagnose", "inspect-stdio", "stdio-cwd"]);
      if (values.apply && values["dry-run"]) {
        throw new Error("Choose --apply or --dry-run, not both.");
      }
      const { importLocalWorkflow, formatImportWorkflow } = await import("./onboarding/import-workflow.js");
      const report = await importLocalWorkflow(client, hub, { clients: values.client, scope: values.scope, project: values.project,
        home: values.home, select: values.select, prefix: values.prefix, fetchA2aCards: values["fetch-a2a-cards"],
        interactive: values.interactive, profile: values.profile, saveProfile: values["save-profile"], profilesFile: values["profiles-file"],
        apply: values.apply, compare: values.compare, details: values.details, onConflict: values["on-conflict"],
        tokenEnv: values["token-env"] ?? credentialDefaults?.tokenEnv, readTokenEnv: credentialDefaults?.readTokenEnv,
        refresh: values.refresh, diagnose: values.diagnose, inspectStdio: values["inspect-stdio"], stdioCwd: values["stdio-cwd"] });
      printOnboarding(report, values.json || values.details, () => formatImportWorkflow(report));
      process.exitCode = report.failed ? 1 : 0;
      return;
    }
    if (action === "sync-local") {
      validateArguments(positionals, 2, values, ["hub", "profile", "profiles-file", "apply", "dry-run", "prune", "fetch-a2a-cards", "refresh", "diagnose", "inspect-stdio", "stdio-cwd"]);
      if (!values.profile || values.apply && values["dry-run"]) {
        throw new Error("Use registry sync-local --profile NAME with a preview or explicit --apply.");
      }
      const { syncLocalWorkflow } = await import("./onboarding/import-workflow.js");
      const report = await syncLocalWorkflow(client, hub, { profile: values.profile, profilesFile: values["profiles-file"], apply: values.apply,
        prune: values.prune, fetchA2aCards: values["fetch-a2a-cards"], refresh: values.refresh, diagnose: values.diagnose,
        inspectStdio: values["inspect-stdio"], stdioCwd: values["stdio-cwd"] });
      printOnboarding(report, values.json, () => "Synchronization " + (report.applied ? "applied" : "preview") + ": " + JSON.stringify(report.profile)
        + "\n" + report.plan.items.map((item) => item.action.toUpperCase() + " " + item.id + (item.fields.length ? " " + item.fields.join(", ") : "")
          + (item.issue ? " " + item.issue : "")).join("\n") + "\n" + (report.failed ? "Review failed or conflicting outcomes." : "No tools or tasks were invoked."));
      process.exitCode = report.failed ? 1 : 0;
      return;
    }
    if (action === "duplicates") {
      validateArguments(positionals, 2, values, ["hub", "limit", "keep", "remove", "apply"]);
      const { manageDuplicates } = await import("./registry/duplicates.js");
      const report = await manageDuplicates(client, { limit: values.limit === undefined ? undefined : Number(values.limit),
        keep: values.keep, remove: values.remove, apply: values.apply });
      printOnboarding(report, values.json, () => report.groups.length + " duplicate groups. " + (report.applied ? "Cleanup attempted." : "Preview only.")
        + "\n" + report.groups.map((group) => group.ids.join(", ") + (group.differingFields.length ? " differs: " + group.differingFields.join(", ") : "")).join("\n")
        + "\nNo target tool/task calls were made.");
      process.exitCode = report.ready ? 0 : 1;
      return;
    }
    if (action === "import-config") {
      validateArguments(positionals, 3, values, ["hub", "format", "select", "prefix", "apply", "dry-run", "on-conflict", "compare", "details"]);
      if (values.apply && (values["dry-run"] || values.compare) || values.details && !values.compare) {
        throw new Error("Choose either --apply or a preview (--compare/--dry-run). --details requires --compare.");
      }
      const { inspectConfigFile, sourceFormatSchema } = await import("./onboarding/import-config.js");
      const preparation = await inspectConfigFile(positionals[2]!, { format: sourceFormatSchema.parse(values.format ?? "auto"),
        select: values.select, prefix: values.prefix, hub });
      await finishPreparedImport(preparation, client, Boolean(values.apply), values["on-conflict"], values.json, values.compare, values.details);
      return;
    }
    if (action === "export") {
      validateArguments(positionals, 3, values, ["hub", "overwrite"]);
      const { writeSnapshot } = await import("./registry/files.js");
      const snapshot = await client.exportRegistry();
      const path = await writeSnapshot(positionals[2]!, snapshot, values.overwrite);
      printJson({ path, targets: snapshot.targets.length });
      return;
    }
    if (action === "import") {
      validateArguments(positionals, 3, values, ["hub", "on-conflict", "dry-run"]);
      const { readSnapshot } = await import("./registry/files.js");
      const { importOptionsSchema } = await import("./registry/schema.js");
      const options = importOptionsSchema.parse({
        onConflict: values["on-conflict"], dryRun: values["dry-run"],
      });
      printJson(await client.importRegistry(await readSnapshot(positionals[2]!), options));
      return;
    }
    throw new Error("Unknown registry command. Run --help for usage.");
  }
  if (command !== "target") {
    throw new Error("Unknown command. Run --help for usage.");
  }

  // 6. Validate command arguments and input files before printing results.
  const action = positionals[1];
  if (action === "inspect-stdio") {
    validateArguments(positionals, 3, values, ["hub", "apply", "stdio-cwd"]);
    const id = targetIdSchema.parse(positionals[2]);
    if ((await client.get(id)).connection.transport !== "stdio") {
      throw new Error("Select a registered stdio MCP target for inspect-stdio.");
    }
    const { followUpImport } = await import("./onboarding/import-follow-up.js");
    const { expected: _expected, ...report } = await followUpImport(client, [id], {
      diagnose: true, refresh: Boolean(values.apply), inspectStdio: true, stdioCwd: values["stdio-cwd"] });
    printOnboarding(report, values.json, () => report.outcomes.map((item) => item.id + " " + item.status + (item.updated ? " (metadata updated)" : "")).join("\n")
      + "\nThe local server process was authorized for metadata inspection only; no tools were called.");
    process.exitCode = report.failed ? 1 : 0;
    return;
  }
  if (["edit", "enable", "disable"].includes(action ?? "")) {
    validateArguments(positionals, 3, values, ["hub", "dry-run", "if-match", ...(action === "edit" ? ["name", "description", "add-tag", "remove-tag"] : [])]);
    const { editTarget } = await import("./targets/edit.js");
    const result = await editTarget(client, positionals[2]!, action === "edit" ? {
      name: values.name, description: values.description, addTags: values["add-tag"], removeTags: values["remove-tag"],
    } : { enabled: action === "enable" }, { dryRun: values["dry-run"], ifMatch: values["if-match"] });
    printOnboarding({ action, ...result }, values.json, () => result.id + ": " + (result.applied ? "Updated." : result.hasChanges
      ? "Preview only; no registry changes." : "No changes needed; the observed registration already matches.")
      + "\nBase version: " + result.baseVersion
      + "\n" + result.changes.map((change) => change.field + ": " + JSON.stringify(change.before) + " -> " + JSON.stringify(change.after)).join("\n"));
    return;
  }
  if (action === "check") {
    validateArguments(positionals, 3, values, ["hub", "bearer-env"]);
    const id = targetIdSchema.parse(positionals[2]);
    const { checkTarget, targetCheckOptionsSchema } = await import("./targets/check.js");
    const options = targetCheckOptionsSchema.parse({ bearerEnv: values["bearer-env"] });
    const versioned = await client.getVersioned(id);
    const report = await checkTarget(versioned.target, options);
    printJson({ ...report, targetVersion: versioned.etag });
    process.exitCode = report.status === "failed" ? 1 : report.status === "skipped" ? 2 : 0;
    return;
  }
  if (action === "import") {
    validateArguments(positionals, 3, values, [
      "hub", "id", "protocol", "name", "description", "tag", "transport", "bearer-env", "dry-run",
      "a2a-binding", "a2a-version",
    ]);
    if (values.protocol === "a2a" && values.transport !== undefined) {
      throw new Error("--transport is only available for MCP imports.");
    }
    const { inspectRemote, remoteImportSchema } = await import("./remote-import.js");
    const target = await inspectRemote(remoteImportSchema.parse({
      id: values.id, protocol: values.protocol, url: positionals[2],
      name: values.name, description: values.description, transport: values.transport,
      tags: values.tag ? [values.tag] : [], bearerEnv: values["bearer-env"],
      a2aBinding: values["a2a-binding"], a2aVersion: values["a2a-version"],
    }));
    printJson(values["dry-run"] ? target : await client.create(target));
    return;
  }
  if (action === "refresh") {
    if (values.all || values.select !== undefined) {
      validateArguments(positionals, 2, values, ["hub", "all", "select", "apply", "dry-run", "q", "protocol", "tag", "include-disabled", "limit", "concurrency"]);
      if (values.all && values.select !== undefined || values.select !== undefined && ["q", "protocol", "tag"].some((key) => values[key as keyof typeof values] !== undefined)) {
        throw new Error("Choose --all with discovery filters or repeated --select IDs, not both.");
      }
      if (values.apply && values["dry-run"]) {
        throw new Error("Choose either a batch preview or --apply, not both.");
      }
      const { batchTargetOptionsSchema } = await import("./targets/batch.js");
      const options = batchTargetOptionsSchema.parse({ select: values.select, q: values.q, protocol: values.protocol, tag: values.tag,
        includeDisabled: values["include-disabled"], limit: values.limit === undefined ? undefined : Number(values.limit),
        concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency) });
      const { refreshBatch } = await import("./targets/refresh-batch.js");
      const report = await refreshBatch(client, options, Boolean(values.apply));
      printOnboarding(report, values.json, () => "Batch refresh " + (report.dryRun ? "preview" : "application") + ": " + report.status.toUpperCase()
        + "\n" + JSON.stringify(report.summary)
        + (report.selectionIssue ? "\n" + report.selectionIssue.code + ": " + report.selectionIssue.message : "")
        + "\n" + report.targets.map((target) => target.id + ": " + target.status + (target.fields.length ? " (" + target.fields.join(", ") + ")" : "")
          + (target.issue ? "\n  " + target.issue.code + ": " + target.issue.message : "")).join("\n")
        + "\n" + (report.dryRun ? "No registry writes. Use --apply to refresh changed targets." : "Updates are independent per target; review failed/skipped outcomes.")
        + "\nTools and tasks were not executed.");
      process.exitCode = report.status === "failed" ? 1 : 0;
      return;
    }
    validateArguments(positionals, 3, values, ["hub", "bearer-env", "dry-run", "a2a-binding", "a2a-version"]);
    const id = targetIdSchema.parse(positionals[2]);
    const { refreshDefinition } = await import("./remote-import.js");
    const selection = a2aSelectionSchema.parse({
      protocolBinding: values["a2a-binding"], protocolVersion: values["a2a-version"],
    });
    const proposal = await refreshDefinition(client, id, values["bearer-env"], selection);
    printJson(values["dry-run"] ? proposal.target : await client.update(id, proposal.target, proposal.etag));
    return;
  }
  if (action === "list") {
    validateArguments(positionals, 2, values, ["hub", "q", "protocol", "tag", "limit", "offset", "include-disabled"]);
    const result = await client.search(searchSchema.parse({
      q: values.q,
      protocol: values.protocol,
      tag: values.tag,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      offset: values.offset === undefined ? undefined : Number(values.offset),
      includeDisabled: values["include-disabled"],
    }));
    if (!values.json && process.stdout.isTTY) {
      process.stdout.write(targetTable(result));
    } else {
      printJson(result);
    }
    return;
  }
  if (action === "add") {
    const source = positionals[2];
    const quick = values.command !== undefined || source !== undefined && (/^https?:/iu.test(source) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(source));
    if (quick) {
      validateArguments(positionals, values.command !== undefined ? 2 : 3, values, [
        "hub", "id", "protocol", "name", "description", "tag", "transport", "bearer-env", "dry-run",
        "a2a-binding", "a2a-version", "command", "arg", "env-var",
      ]);
      const { quickDefinition } = await import("./onboarding/add.js");
      const target = await quickDefinition({ url: source, command: values.command, args: values.arg, envVars: values["env-var"],
        id: values.id, protocol: values.protocol, name: values.name, description: values.description, tag: values.tag,
        transport: values.transport, bearerEnv: values["bearer-env"], a2aBinding: values["a2a-binding"], a2aVersion: values["a2a-version"],
      });
      printJson(values["dry-run"] ? target : await client.create(target));
    } else {
      validateArguments(positionals, 3, values, ["hub"]);
      const target = await readDefinition(source!);
      printJson(await client.create(target));
    }
    return;
  }
  if (action === "update") {
    validateArguments(positionals, 4, values, ["hub", "if-match"]);
    const id = targetIdSchema.parse(positionals[2]);
    const target = await readDefinition(positionals[3]!);
    if (id !== target.id) {
      throw new Error("The command and JSON file must use the same target id.");
    }
    printJson(await client.update(id, target, values["if-match"]));
    return;
  }
  if (action === "get" || action === "remove") {
    validateArguments(positionals, 3, values, action === "get" ? ["hub", "with-version"] : ["hub", "if-match", "dry-run"]);
    const id = targetIdSchema.parse(positionals[2]);
    if (action === "get") {
      printJson(values["with-version"] ? await client.getVersioned(id) : await client.get(id));
    } else if (values["dry-run"]) {
      const { previewRemoval } = await import("./targets/edit.js");
      const result = await previewRemoval(client, id, values["if-match"]);
      printOnboarding({ action, ...result }, values.json, () => "Removal preview: " + result.id + " (" + JSON.stringify(result.target.name) + ")"
        + "\nBase version: " + result.baseVersion + "\nNo registry changes. Use --if-match with this version when removing the target.");
    } else {
      await client.remove(id, values["if-match"]);
      printJson({ deleted: id });
    }
    return;
  }

  throw new Error("Unknown target command. Run --help for usage.");
}

/** Preview prepared connection metadata or submit one atomic import after explicit application. */
async function finishPreparedImport<T extends {
  ready: boolean; targets: TargetDefinition[]; selected: number; converted: number;
  issues: ImportIssue[]; requiredEnvironmentVariables: string[]; metadataAsOf?: string;
  sources?: { id: string; path: string; status: string; entries: number }[];
  entries?: { key: string; status: string; targetId?: string; duplicateOf?: string }[];
}>(preparation: T, client: HubClient, apply: boolean, onConflict: string | undefined, json: boolean | undefined,
  compare?: boolean, details?: boolean): Promise<void> {
  // 1. Preserve the existing conflict policy and refuse partial application of blocked plans.
  const { importOptionsSchema } = await import("./registry/schema.js");
  const { preparedSnapshot } = await import("./onboarding/import-config.js");
  const options = importOptionsSchema.parse({ onConflict, dryRun: false });
  const result = apply && preparation.ready ? await client.importRegistry(preparedSnapshot(preparation.targets, preparation.metadataAsOf), options) : undefined;
  const { compareRegistry, formatComparison } = await import("./registry/diff.js");
  const comparison = compare && preparation.ready ? await compareRegistry(client, preparedSnapshot(preparation.targets, preparation.metadataAsOf), { onConflict, details }) : undefined;
  const ready = preparation.ready && (comparison?.importReady ?? true);

  // 2. Print only the prepared definitions and fixed diagnostics, never the original source file.
  const report = { ...preparation, ready, applied: result !== undefined, onConflict: options.onConflict,
    hubConflictsChecked: result !== undefined || comparison !== undefined, ...(result ? { result } : {}), ...(comparison ? { comparison } : {}) };
  printOnboarding(report, json || details, () => preparation.converted + "/" + preparation.selected + " selected connections prepared. "
    + (result ? "Applied to the hub." : ready ? "Preview only; no hub changes. Use the import command with --apply to register." : "Not ready; resolve source errors or destination conflicts.")
    + (preparation.sources ? "\nSources:\n" + preparation.sources.filter((source) => source.status !== "missing")
      .map((source) => JSON.stringify(source.id) + " " + source.status + " (" + source.entries + ") " + JSON.stringify(source.path)).join("\n") : "")
    + (preparation.entries ? "\nSelection keys:\n" + preparation.entries.map((entry) => JSON.stringify(entry.key) + " " + entry.status
      + (entry.targetId ? " -> " + JSON.stringify(entry.targetId) : "") + (entry.duplicateOf ? " (same connection as " + JSON.stringify(entry.duplicateOf) + ")" : "")).join("\n") : "")
    + "\n" + preparation.targets.map((target) => target.id + " (" + target.connection.transport + ")").join("\n")
    + "\n" + preparation.issues.map((issue) => issue.severity.toUpperCase() + " " + JSON.stringify(issue.name) + " " + issue.code + ": " + issue.message).join("\n")
    + (preparation.requiredEnvironmentVariables.length ? "\nRequired in the consuming environment: " + preparation.requiredEnvironmentVariables.join(", ") : "")
    + (comparison ? "\n" + formatComparison(comparison) : "")
    + ("metadataInspected" in preparation && preparation.metadataInspected
      ? "\nSelected A2A card metadata was inspected. No target tasks or tools were executed."
      : "\nNo target connections or executions were performed."));
  if (!ready) {
    process.exitCode = 1;
  }
}

/** Validate positional argument counts and supported options for each command. */
function validateArguments(
  positionals: string[],
  expectedCount: number,
  values: Record<string, unknown>,
  allowedOptions: string[],
): void {
  // 1. Reject missing or extra positional arguments.
  if (positionals.length !== expectedCount) {
    throw new Error("Check the command argument count. Run --help for usage.");
  }

  // 2. Reject options belonging to another command instead of silently ignoring them.
  const allowed = [...allowedOptions, "config", "json", ...(allowedOptions.includes("hub") ? ["token-env", "hub-profile", "hub-profiles-file"] : [])];
  const unexpected = Object.keys(values).filter((name) => name !== "help" && !allowed.includes(name));
  if (unexpected.length > 0) {
    throw new Error("Unsupported options for this command: " + unexpected.join(", "));
  }
}

/** Read a bounded JSON file and validate its target definition. */
async function readDefinition(path: string) {
  // 1. Apply the same body size limit as the HTTP API.
  if ((await stat(path)).size > 1_048_576) {
    throw new Error("Target definition files must not exceed 1 MiB.");
  }

  // 2. Validate JSON syntax, protocol, and connection details.
  return targetDefinitionSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Print CLI results as JSON for automation. */
function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
