import spawn from "cross-spawn";
import { spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PACKAGE_VERSION } from "./version.js";
import { targetDefinitionSchema, type TargetDefinition } from "./targets/schema.js";

type StdioConnection = Extract<TargetDefinition["connection"], { transport: "stdio" }>;

/** Preserve Windows' case-insensitive environment lookups even when callers provide a plain object snapshot. */
function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = process.platform === "win32" ? Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase()) : name;
  return key === undefined ? undefined : environment[key];
}

/** Distinguish an interrupted inspection so a workflow can stop further processes and save acknowledged ownership. */
export class StdioInspectionCancelled extends Error {
  /** Carry a fixed diagnostic without exposing process arguments or server output. */
  constructor() {
    super("Stdio metadata inspection was cancelled; the owned process was stopped.");
  }
}

/** Own a literal-command stdio session and bound both its protocol output and process lifetime. */
class InspectionTransport implements Transport {
  onmessage: Transport["onmessage"];
  onerror: Transport["onerror"];
  onclose: Transport["onclose"];
  private child: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 1_048_576 });
  private outputBytes = 0;
  private errorBytes = 0;
  private closing: Promise<void> | undefined;
  private closed = false;

  /** Retain validated process arguments and the minimal explicitly constructed consumer environment. */
  constructor(private readonly connection: StdioConnection, private readonly environment: Record<string, string>, private readonly cwd: string) {}

  /** Start a portable command shim without a shell and report only fixed transport diagnostics. */
  async start(): Promise<void> {
    if (this.child || this.closed) {
      throw new Error("The metadata transport cannot be restarted.");
    }
    await new Promise<void>((accept, reject) => {
      const child = spawn(this.connection.command, this.connection.args, { cwd: this.cwd, env: this.environment,
        shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.once("spawn", accept);
      child.once("error", () => {
        const error = new Error("Unable to start the selected stdio metadata server.");
        reject(error);
        this.fail(error);
      });
      child.once("close", () => {
        this.closed = true;
        this.onclose?.();
        void this.close();
      });
      child.stdin?.on("error", () => this.fail(new Error("The stdio metadata input closed unexpectedly.")));
      child.stdout?.on("error", () => this.fail(new Error("Unable to read stdio metadata.")));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.outputBytes += chunk.length;
        if (this.outputBytes > 4_194_304) {
          this.fail(new Error("Stdio metadata output exceeded 4 MiB."));
          return;
        }
        try {
          this.buffer.append(chunk);
          for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
            this.onmessage?.(message);
          }
        } catch {
          this.fail(new Error("Invalid or oversized stdio metadata protocol output."));
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.errorBytes += chunk.length;
        if (this.errorBytes > 65_536) {
          this.fail(new Error("Stdio diagnostic output exceeded 64 KiB."));
        }
      });
    });
  }

  /** Forward only SDK-generated JSON-RPC messages to the owned process. */
  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || this.closed || this.closing) {
      throw new Error("Stdio metadata connection is closed.");
    }
    await new Promise<void>((accept, reject) => input.write(serializeMessage(message), (error) => error
      ? reject(new Error("Unable to send a stdio metadata request.")) : accept()));
  }

  /** Report a bounded failure and close the session so pending SDK requests cannot remain open. */
  private fail(error: Error): void {
    this.onerror?.(error);
    void this.close();
  }

  /** Stop the owned process group or Windows process tree once, including after protocol errors and deadlines. */
  async close(): Promise<void> {
    this.closing ??= this.stop();
    await this.closing;
  }

  /** Terminate owned descendants while avoiding repeated signals against an already completed session. */
  private async stop(): Promise<void> {
    const pid = this.child?.pid;
    if (pid) {
      if (process.platform === "win32") {
        const executable = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe");
        spawnSync(executable, ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 2000 });
      } else {
        try {
          process.kill(-pid, "SIGTERM");
          await delay(150);
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            this.onerror?.(new Error("Unable to terminate the owned stdio process group."));
          }
        }
      }
    }
    this.buffer.clear();
    if (!this.closed) {
      this.closed = true;
      this.onclose?.();
    }
  }
}

/** Initialize an explicitly authorized local MCP process and list bounded tools without calling any tool. */
export async function inspectStdio(input: TargetDefinition, options: { allow: boolean; cwd?: string | undefined; timeoutMs?: number | undefined },
  environment: NodeJS.ProcessEnv = process.env) {
  // 1. Require authorization and all declared variables before starting any executable.
  const target = targetDefinitionSchema.parse(input);
  if (!options.allow || target.protocol !== "mcp" || target.connection.transport !== "stdio") {
    throw new Error("Stdio metadata inspection requires --inspect-stdio and a local MCP definition.");
  }
  const env: Record<string, string> = {};
  for (const name of [...DEFAULT_INHERITED_ENV_VARS, ...(process.platform === "win32" ? ["PATHEXT", "COMSPEC"] : [])]) {
    const value = environmentValue(environment, name);
    if (value !== undefined && !value.startsWith("()")) {
      env[name] = value;
    }
  }
  for (const name of target.connection.envVars) {
    const value = environmentValue(environment, name);
    if (value === undefined || value.length === 0) {
      throw new Error("A declared stdio environment variable is missing.");
    }
    env[name] = value;
  }

  // 2. Own the process and apply one overall metadata deadline across initialization and every page.
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Stdio metadata timeouts must be between 1 and 30000 ms.");
  }
  const interruption = new AbortController();
  let interrupted = false;
  /** Convert terminal/process interrupts into SDK cancellation while allowing owned-process cleanup to finish. */
  function cancel() {
    interrupted = true;
    interruption.abort();
  }
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), interruption.signal]);
  const transport = new InspectionTransport(target.connection, env, resolve(options.cwd ?? process.cwd()));
  const client = new Client({ name: "agent-tcdh-stdio-inspection", version: PACKAGE_VERSION });
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    const capabilities = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: timeoutMs });
      capabilities.push(...result.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })));
      if (capabilities.length > 200) {
        throw new Error("Stdio metadata exceeds 200 tools.");
      }
      cursor = result.nextCursor;
      if (!cursor) {
        return targetDefinitionSchema.parse({ ...target, capabilities });
      }
      if (cursors.has(cursor)) {
        throw new Error("Stdio metadata repeats a pagination cursor.");
      }
      cursors.add(cursor);
    }
    throw new Error("Stdio metadata exceeds 50 pages.");
  } catch {
    throw new Error("Unable to inspect stdio metadata within its process, protocol, or resource bounds. Server output was not printed.");
  } finally {
    // 3. Always release the SDK session and owned process tree; collected tools are never invoked.
    await client.close();
    await transport.close();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (interrupted) {
      throw new StdioInspectionCancelled();
    }
  }
}
