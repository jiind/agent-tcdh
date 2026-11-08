import { createInterface } from "node:readline/promises";
import type { HubClient } from "../client.js";
import { connectClient, connectionClientSchema } from "./connect.js";
import { importLocalWorkflow, type ImportWorkflowOptions } from "./import-workflow.js";
import { prepareLocalImport } from "./local-import.js";
import { selectImportEntries } from "./import-select.js";

/** Guide source selection, registration, and consumer connection through existing guarded workflows. */
export async function setupConsumer(client: HubClient, hub: string, options: ImportWorkflowOptions & {
  client?: string | undefined; write?: string | undefined; replace?: boolean | undefined; yes?: boolean | undefined;
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
  const connectionOptions = { client: selectedClient, hub, tokenEnv: options.readTokenEnv ?? options.tokenEnv,
    write: options.write, replace: options.replace };
  const connectionPreview = await connectClient({ ...connectionOptions, dryRun: Boolean(options.write) });
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
      next: "Review the selection, then repeat setup with --apply. --write FILE explicitly selects a client configuration destination.", executionVerified: false };
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
  let connectionFailed = false;
  if (registration.applied) {
    try {
      connection = await connectClient(connectionOptions);
    } catch {
      connectionFailed = true;
    }
  }
  return { applied: registration.applied, ready: registration.ready, registration, connection,
    connectionFailed, failed: registration.failed || connectionFailed,
    next: connectionFailed ? "Registrations may already be saved. Retry connect for the selected explicit file; do not blindly repeat registration."
      : "Start/reload the consuming agent to load its settings. Target execution remains unverified.", executionVerified: false };
}
