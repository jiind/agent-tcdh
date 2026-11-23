import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubClient } from "../client.js";
import { connectClient, connectionClientSchema } from "./connect.js";
import { ConfigurationFileError } from "./files.js";
import { importLocalWorkflow, type ImportWorkflowOptions } from "./import-workflow.js";
import { prepareLocalImport } from "./local-import.js";
import { selectImportEntries } from "./import-select.js";

/** Report a safe local write diagnostic without reading arbitrary error messages. */
function connectionFailureMessage(error: unknown): string {
  if (error instanceof ConfigurationFileError) {
    return error.message;
  }
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "Check the client configuration and directory write permissions.";
    case "ENOSPC":
    case "EDQUOT":
      return "Free disk space for the client configuration and its backup.";
    case "ENOENT":
    case "ENOTDIR":
      return "Check that the client configuration path and its parent directory are available.";
    default:
      return "The client configuration could not be saved. Check the destination and retry.";
  }
}

/** Guide source selection, registration, and consumer connection through existing guarded workflows. */
export async function setupConsumer(client: HubClient, hub: string, options: ImportWorkflowOptions & {
  client?: string | undefined; write?: string | undefined; replace?: boolean | undefined; yes?: boolean | undefined;
  plan?: boolean | undefined; connectionTokenEnv?: string | undefined; config?: string | undefined;
  hubProfile?: string | undefined; hubProfilesFile?: string | undefined;
}) {
  // 1. Resolve terminal choices and preflight the connection output before any registry or local writes.
  if (!options.yes && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new Error("Setup requires a terminal or --yes with an explicit --client. Preview is the default; --apply authorizes changes.");
  }
  const prompt = options.yes ? undefined : createInterface({ input: process.stdin, output: process.stderr });
  let selectedClient;
  try {
    selectedClient = connectionClientSchema.parse(options.client ?? (prompt ? (await prompt.question("Consumer client (codex, opencode, claude-code, gemini-cli, cursor, vscode): ")).trim() : undefined));
  } finally {
    prompt?.close();
  }
  const connectionOptions = { client: selectedClient, hub, tokenEnv: options.connectionTokenEnv ?? options.readTokenEnv ?? options.tokenEnv,
    write: options.write ? resolve(options.write) : undefined, replace: options.replace };
  const connectionPreview = await connectClient({ ...connectionOptions, dryRun: Boolean(options.write), plan: options.plan });
  let select = options.select;
  if (!options.yes && select === undefined) {
    const discovery = await prepareLocalImport({ ...options, hub, fetchA2aCards: false });
    select = await selectImportEntries(discovery.entries);
  }
  const workflow = { ...options, select, interactive: false };
  const preview = await importLocalWorkflow(client, hub, { ...workflow, apply: false, saveProfile: undefined, compare: false,
    refresh: false, diagnose: false, inspectStdio: false });
  if (!preview.ready || !options.apply) {
    return { applied: false, ready: preview.ready, registration: preview, connection: connectionPreview,
      next: "Review the selection, then run setup with --apply"
        + (connectionPreview.plan?.requiresReplace ? " and --replace" : "") + "."
        + (options.plan ? " Omit --plan when applying." : " --write FILE explicitly selects a client configuration destination."),
      executionVerified: false };
  }
  if (!options.yes) {
    const confirmation = createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stderr.write(JSON.stringify({ hub, selected: preview.entries.filter((entry) => entry.selected).map((entry) => entry.key),
        write: options.write ?? null, saveProfile: options.saveProfile ?? null }, null, 2) + "\n");
      if ((await confirmation.question("Apply this registration and the explicitly selected local writes? Type yes: ")).trim() !== "yes") {
        return { applied: false, ready: true, cancelled: true, executionVerified: false };
      }
    } finally {
      confirmation.close();
    }
  }
  // 2. Registration and optional client writes have independent results; never imply a cross-system transaction.
  const registration = await importLocalWorkflow(client, hub, workflow);
  let connection;
  let connectionFailure: { message: string; retryCommand?: string[] } | undefined;
  if (registration.applied) {
    try {
      connection = await connectClient(connectionOptions);
    } catch (error) {
      connectionFailure = { message: connectionFailureMessage(error) };
      if (connectionOptions.write) {
        connectionFailure.retryCommand = [process.execPath, fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
          "connect", selectedClient, "--hub", connectionPreview.hub, "--write", connectionOptions.write,
          ...(connectionOptions.tokenEnv ? ["--token-env", connectionOptions.tokenEnv] : []),
          ...(options.hubProfile ? ["--hub-profile", options.hubProfile] : []),
          ...(options.hubProfile && options.hubProfilesFile ? ["--hub-profiles-file", resolve(options.hubProfilesFile)] : []),
          ...(options.config ? ["--config", options.config] : []), ...(options.replace ? ["--replace"] : [])];
      }
    }
  }
  return { applied: registration.applied, ready: registration.ready, registration, connection,
    connectionFailed: connectionFailure !== undefined, ...(connectionFailure ? { connectionFailure } : {}),
    failed: registration.failed || connectionFailure !== undefined,
    next: connectionFailure ? "Resolve the client configuration issue, then retry connect to finish setup."
      : registration.applied ? "Start/reload the consuming agent to load its settings. Target execution remains unverified."
        : "Review the registration report and preview setup again.", executionVerified: false };
}
