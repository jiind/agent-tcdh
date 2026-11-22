import assert from "node:assert/strict";
import { commandVersion, spawnCommand as spawn, stopProcessTree } from "./process-utils.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Fastify from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../dist/app.js";
import { mergeConnection } from "../dist/onboarding/connect.js";

const { values } = parseArgs({ options: {
  agent: { type: "string" }, model: { type: "string" }, output: { type: "string" },
  "connection-only": { type: "boolean" },
} });
assert.ok(["codex", "opencode"].includes(values.agent), "Specify --agent codex or --agent opencode.");
assert.ok(values["connection-only"] || values.model, "Specify --model for a reproducible run.");
assert.ok(!values["connection-only"] || values.agent === "opencode", "Connection-only verification is supported for OpenCode.");
const directory = values.output ?? await mkdtemp(join(tmpdir(), "agent-tcdh-live-"));
if (values.output) {
  await mkdir(directory);
}
const workspace = join(directory, "workspace");
await mkdir(workspace, { recursive: true });
const clientVersion = commandVersion(values.agent);
const openCodeMajor = values.agent === "opencode" ? clientVersion.match(/\bv?([12])\.\d+\.\d+\b/iu)?.[1] : undefined;
if (values.agent === "opencode") {
  assert.ok(openCodeMajor, "Use an OpenCode 1.x or 2.x binary for version-specific verification.");
}
const connectionProfile = values.agent === "codex" ? "codex" : openCodeMajor === "1" ? "opencode-v1" : "opencode";
const events = [];
const receipts = { mcp: [], a2a: [] };
const challenge = randomUUID();
const readToken = randomUUID();
const adminToken = randomUUID();
const targetToken = randomUUID();
const tag = "acceptance-" + randomUUID().slice(0, 8);
const target = Fastify({ logger: false });
const hub = createApp({ logger: false, token: adminToken, readToken });

/** Issue unpredictable receipts only during authenticated direct execution. */
function receipt(protocol) {
  const value = protocol + "-" + randomUUID();
  receipts[protocol].push(value);
  return value;
}

/** Redact temporary verification tokens from captured evidence. */
function redact(value) {
  return [readToken, adminToken, targetToken].reduce((text, token) => text.replaceAll(token, "<test-token>"), value);
}

/** Record protocol requests to test targets without retaining token values. */
function recordTarget(request, _reply, done) {
  events.push({ source: "target", path: request.url, method: request.body?.method });
  done();
}
target.addHook("preHandler", recordTarget);
target.addHook("preHandler", async (request, reply) => {
  if (request.headers.authorization !== "Bearer " + targetToken) {
    return reply.code(401).send({ error: "Authentication required." });
  }
});
target.post("/mcp", async (request, reply) => {
  // 1. Prepare an independent MCP target supporting initialization, listing, and execution.
  const peer = new Server({ name: "Acceptance receipt MCP", version: "1.0.0" }, { capabilities: { tools: {} } });
  peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "issue_receipt", description: "Accept a challenge and return a one-time receipt proving actual execution.",
    inputSchema: { type: "object", properties: { challenge: { type: "string" } }, required: ["challenge"], additionalProperties: false },
  }] }));
  peer.setRequestHandler(CallToolRequestSchema, async (input) => {
    assert.equal(input.params.name, "issue_receipt");
    assert.equal(input.params.arguments?.challenge, challenge);
    return { content: [{ type: "text", text: receipt("mcp") }] };
  });

  // 2. Send the protocol response and clean up the connection.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  await peer.connect(transport);
  reply.hijack();
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } finally {
    await peer.close();
  }
});
let targetUrl;
target.get("/.well-known/agent-card.json", async () => ({
  protocolVersion: "0.3.0", name: "Acceptance receipt agent", description: "Proof of actual A2A execution",
  url: targetUrl + "/a2a", preferredTransport: "JSONRPC", version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
  skills: [{ id: "issue_receipt", name: "Issue receipt", description: "Accept a text challenge and return an execution receipt.", tags: [tag] }],
}));
target.post("/a2a", async (request, reply) => {
  const input = request.body;
  if (input?.jsonrpc !== "2.0" || input.method !== "message/send") {
    return { jsonrpc: "2.0", id: input?.id ?? null, error: { code: -32601, message: "Unsupported method." } };
  }
  const message = input.params?.message;
  if (message?.kind !== "message" || message.role !== "user" || !message.messageId
    || !message.parts?.some((part) => part.kind === "text" && part.text.includes(challenge))) {
    return reply.code(400).send({ jsonrpc: "2.0", id: input.id, error: { code: -32602, message: "A user message containing the challenge is required." } });
  }

  return { jsonrpc: "2.0", id: input.id, result: {
    kind: "message", role: "agent", messageId: randomUUID(),
    parts: [{ kind: "text", text: receipt("a2a") }],
  } };
});
hub.addHook("preHandler", async (request) => {
  events.push({ source: "hub", path: request.url, method: request.body?.method, tool: request.body?.params?.name,
    usedReadCredential: request.headers.authorization === "Bearer " + readToken });
});

/** Register connection information and credential references in the temporary hub. */
async function register(protocol) {
  const response = await fetch(hubUrl + "/api/targets", {
    method: "POST", headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: tag + "-" + protocol, name: "Acceptance " + protocol,
      description: "Issue a one-time execution receipt " + tag, protocol, tags: [tag],
      capabilities: [{ name: "issue_receipt", description: "Send a challenge to receive an execution receipt.",
        inputSchema: { type: "object", properties: { challenge: { type: "string" } }, required: ["challenge"] } }],
      connection: { transport: protocol === "mcp" ? "streamable-http" : "http", url: targetUrl + "/" + protocol,
        ...(protocol === "a2a" ? { agentCardUrl: targetUrl + "/.well-known/agent-card.json" } : {}),
        auth: { type: "bearer", envVars: ["TCDH_ACCEPT_TARGET_TOKEN"] },
      },
    }),
  });
  assert.equal(response.status, 201, await response.text());
}

/** Run an actual agent CLI within a deadline and capture evidence. */
async function run(command, args, env) {
  // 1. Manage the CLI process group and captured output.
  const child = spawn(command, args, { cwd: workspace, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let externalFailure;

  /** Stop on provider authentication, availability, or quota failures without repeated requests. */
  function stopOnProviderFailure(text) {
    const diagnostic = text.split("\n").filter((line) => line.includes("level=ERROR") || /^\{"type":"error"[,}]/u.test(line)).join("\n");
    const failure = diagnostic.match(/Model is unavailable|ProviderModelNotFoundError|insufficient.credits|rate.limit|too many requests|unauthorized/iu)?.[0];
    if (!externalFailure && failure) {
      externalFailure = failure;
      stopProcessTree(child);
    }
  }
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    stopOnProviderFailure(stdout);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    stopOnProviderFailure(stderr);
  });
  const timer = setTimeout(() => {
    stopProcessTree(child);
  }, 180_000);

  // 2. Record success or failure logs and clean up background processes.
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await writeFile(join(directory, "stdout.jsonl"), redact(stdout));
    await writeFile(join(directory, "stderr.log"), redact(stderr));
    return { code, stdout, stderr, externalFailure };
  } finally {
    clearTimeout(timer);
    stopProcessTree(child);
  }
}

let hubUrl;
try {
  // 1. Start the real hub and independent protocol targets on temporary ports.
  targetUrl = await target.listen({ host: "127.0.0.1", port: 0 });
  hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
  await register("mcp");
  await register("a2a");
  const env = { ...process.env, PWD: workspace, TCDH_ACCEPT_READ_TOKEN: readToken, TCDH_ACCEPT_TARGET_TOKEN: targetToken };
  const prompt = `Verify the actual integration. Use the connected agent_tcdh search_targets tool to find MCP and A2A targets tagged ${tag}, then use get_target for their current connection details. Call each target's issue_receipt capability directly with challenge ${challenge}. Obtain target URLs only from hub results. Read target credentials from the environment variables referenced by connection.auth.envVars without printing their values. Shell HTTP/protocol clients may be used if native tools cannot connect directly. Read the A2A Agent Card and use its declared protocol. The hub provides discovery and does not relay execution. Do not edit personal or MCP configuration files, invoke external models or subagents, access files outside the current workspace, or contact networks other than the hub and targets. Return only JSON containing actual target results: {"mcpReceipt":"...","a2aReceipt":"...","executionMethod":"method used"}. Report execution failures honestly; never guess receipt values.`;

  // 2. Configure only the hub in the agent's MCP settings, without target-specific setup.
  let args;
  if (values.agent === "codex") {
    args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json",
      "--model", values.model, "--sandbox", "workspace-write", "-c", "approval_policy=\"never\"",
      "-c", "sandbox_workspace_write.network_access=true", "-c", "model_reasoning_effort=\"medium\"",
      "-c", "mcp_servers.agent_tcdh.url=" + JSON.stringify(hubUrl + "/mcp"),
      "-c", "mcp_servers.agent_tcdh.bearer_token_env_var=\"TCDH_ACCEPT_READ_TOKEN\"",
      "-c", "mcp_servers.agent_tcdh.default_tools_approval_mode=\"approve\"", prompt];
  } else {
    env.XDG_CONFIG_HOME = join(directory, "config");
    env.XDG_DATA_HOME = join(directory, "data");
    env.XDG_CACHE_HOME = join(directory, "cache");
    env.XDG_STATE_HOME = join(directory, "state");
    env.OPENCODE_DISABLE_CLAUDE_CODE = "true";
    env.OPENCODE_DISABLE_AUTOUPDATE = "true";
    env.OPENCODE_CONFIG_DIR = join(directory, "config", "opencode");
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      enabled_providers: ["opencode"], model: values.model, autoupdate: false, snapshot: false,
      permission: { "*": "deny", bash: "allow", agent_tcdh_search_targets: "allow", agent_tcdh_get_target: "allow" },
      ...JSON.parse(mergeConnection(connectionProfile, hubUrl, "TCDH_ACCEPT_READ_TOKEN").content),
    });
    args = ["run", "--pure", "--dir", workspace, "--print-logs", "--log-level", "DEBUG",
      "--model", values.model, "--variant", "medium", "--format", "json", prompt];
    if (values["connection-only"]) {
      args = ["mcp", "list", "--pure"];
    }
  }
  console.log(JSON.stringify({ agent: values.agent, model: values.model, artifacts: directory, phase: "running" }));
  const result = await run(values.agent, args, env);

  // 3. Compare the model's final answer with actual target execution records.
  const stream = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const messages = stream.flatMap((event) => {
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      return [event.item.text];
    }
    if (event.type === "text" && event.part?.text) {
      return [event.part.text];
    }
    return [];
  });
  const final = redact(messages.at(-1) ?? "");
  const hubTools = events.filter((event) => event.source === "hub" && event.method === "tools/call").map((event) => event.tool);
  const summary = {
    agent: values.agent, clientVersion, connectionProfile, model: values.model, exitCode: result.code,
    mode: values["connection-only"] ? "connection-only" : "execution", externalFailure: result.externalFailure,
    hubInitialized: events.some((event) => event.source === "hub" && event.method === "initialize" && event.usedReadCredential),
    hubToolsListed: events.some((event) => event.source === "hub" && event.method === "tools/list"),
    hubSearchCalls: hubTools.filter((name) => name === "search_targets").length,
    hubGetCalls: hubTools.filter((name) => name === "get_target").length,
    mcpCalls: receipts.mcp.length, a2aCalls: receipts.a2a.length,
    mcpReceiptMatched: receipts.mcp.some((value) => final.includes(value)),
    a2aReceiptMatched: receipts.a2a.some((value) => final.includes(value)), final,
  };
  await writeFile(join(directory, "events.json"), JSON.stringify(events, null, 2) + "\n");
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(result.code, 0, "The CLI run failed. See stderr.log.");
  if (values["connection-only"]) {
    assert.ok(summary.hubInitialized, "OpenCode must complete MCP initialization with the actual hub.");
  } else {
    assert.ok(summary.hubSearchCalls > 0 && summary.hubGetCalls >= 2, "The agent must search and retrieve targets through the hub MCP tools.");
    assert.ok(summary.mcpReceiptMatched && summary.a2aReceiptMatched, "The final answer must contain the receipts issued by the actual targets.");
  }
} finally {
  await hub.close();
  await target.close();
}
