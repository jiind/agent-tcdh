import assert from "node:assert/strict";
import { commandVersion, spawnCommand as spawn, stopProcessTree } from "./process-utils.mjs";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import Fastify from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../dist/app.js";
import { HubClient } from "../dist/client.js";
import { auditSummaryBatch } from "./selection-audit.mjs";

const { values } = parseArgs({ options: {
  count: { type: "string", default: "3" }, model: { type: "string" }, output: { type: "string" },
  workflow: { type: "string", default: "single" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("Usage: npm run test:selection -- --model MODEL [--count 1..8] [--workflow single|summary-batch] [--output DIRECTORY]");
  process.exit(0);
}
const count = Number(values.count);
const summaryBatch = values.workflow === "summary-batch";
assert.ok(summaryBatch || values.workflow === "single", "Use --workflow single or summary-batch.");
assert.ok(Number.isInteger(count) && count >= 1 && count <= 8, "Use --count 1..8.");
assert.ok(values.model, "Specify --model for an opt-in real Codex run.");
const directory = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), "agent-tcdh-selection-"));
if (values.output) {
  await mkdir(directory);
}
const workspace = join(directory, "workspace");
await mkdir(workspace);
const version = commandVersion("codex");
const challenge = randomUUID();
const tokens = { admin: randomUUID(), read: randomUUID(), target: randomUUID() };
const tag = "selection-" + randomUUID().slice(0, 8);
const events = [];
const executions = [];
const cases = [
  { name: "sum_numbers", description: "Add all numbers in the supplied list.", input: [12, 7, 23], expected: 42 },
  { name: "uppercase_text", description: "Convert the supplied text to uppercase.", input: "agent discovery", expected: "AGENT DISCOVERY" },
  { name: "sort_numbers", description: "Sort the supplied list of numbers in ascending order.", input: [19, 2, 11], expected: [2, 11, 19] },
  { name: "count_words", description: "Count whitespace-separated words in the supplied text.", input: "tools and agents work together", expected: 5 },
  { name: "unique_values", description: "Remove duplicate strings while preserving their first occurrence order.", input: ["mcp", "a2a", "mcp"], expected: ["mcp", "a2a"] },
  { name: "reverse_text", description: "Reverse the characters of the supplied text.", input: "discovery", expected: "yrevocsid" },
  { name: "maximum_number", description: "Return the largest number from the supplied list.", input: [4, 81, 16], expected: 81 },
  { name: "text_length", description: "Count characters, including spaces, in the supplied ASCII text.", input: "hello hub", expected: 9 },
];
// Random IDs, order, and protocol assignments prevent selection by a fixed target position.
const candidates = cases.map((item, index) => ({ ...item, id: "provider-" + randomUUID().slice(0, 8),
  protocol: index % 2 === randomInt(2) ? "mcp" : "a2a", selected: false, decoy: false }));
// Keep both protocols represented among requested targets whenever at least two are requested.
candidates[0].protocol = "mcp";
candidates[1].protocol = "a2a";
for (const item of candidates.slice(0, count)) {
  item.selected = true;
}
for (const protocol of ["mcp", "a2a"]) {
  candidates.push({ id: "provider-" + randomUUID().slice(0, 8), protocol, name: "delete_records",
    description: "Delete stored records. This mutating capability cannot perform read-only calculations or text transformations.",
    decoy: true, selected: false });
}
const schema = { type: "object", properties: {
  challenge: { type: "string" }, input: {},
}, required: ["challenge", "input"], additionalProperties: false };
const target = Fastify({ logger: false });
const hub = createApp({ logger: false, token: tokens.admin, readToken: tokens.read });
let targetUrl;
let child;
let timer;
let stdout = "";
let stderr = "";

/** Redact temporary credentials from any recorded CLI text. */
function redact(text) {
  return Object.values(tokens).reduce((result, token) => result.replaceAll(token, "<test-token>"), text);
}

/** Validate the selected capability and issue a receipt that the consumer cannot predict. */
function execute(provider, args) {
  assert.ok(provider.selected && !provider.decoy, "An unrelated provider was executed.");
  assert.equal(args.challenge, challenge);
  assert.deepEqual(args.input, provider.input);
  const record = { targetId: provider.id, task: provider.name, protocol: provider.protocol,
    value: provider.expected, receipt: randomUUID() };
  executions.push(record);
  return record;
}

target.addHook("preHandler", async (request, reply) => {
  events.push({ source: "target", path: request.url, method: request.body?.method, tool: request.body?.params?.name });
  if (request.headers.authorization !== "Bearer " + tokens.target) {
    return reply.code(401).send({ error: "Authentication required." });
  }
});
hub.addHook("preHandler", async (request) => {
  const params = request.body?.params;
  const args = params?.arguments;
  events.push({ source: "hub", path: request.url, method: request.body?.method, tool: params?.name,
    ...(params?.name === "get_target" ? { targetId: args?.id } : {}),
    ...(params?.name === "get_targets" ? { targetIds: Array.isArray(args?.ids) ? args.ids : [] } : {}),
    ...(params?.name === "search_targets" ? { search: { view: args?.view, tag: args?.tag, auth: args?.auth, inputs: args?.inputs } } : {}) });
});

for (const provider of candidates) {
  if (provider.protocol === "mcp") {
    target.post("/" + provider.id + "/mcp", async (request, reply) => {
      const peer = new Server({ name: provider.id, version: "1.0.0" }, { capabilities: { tools: {} } });
      peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
        name: provider.name, description: provider.description, inputSchema: schema,
      }] }));
      peer.setRequestHandler(CallToolRequestSchema, async (input) => {
        assert.equal(input.params.name, provider.name);
        return { content: [{ type: "text", text: JSON.stringify(execute(provider, input.params.arguments)) }] };
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await peer.connect(transport);
      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } finally {
        await peer.close();
      }
    });
  } else {
    target.get("/" + provider.id + "/agent-card.json", async () => ({
      protocolVersion: "0.3.0", name: provider.id, description: provider.description, version: "1.0.0",
      url: targetUrl + "/" + provider.id + "/a2a", preferredTransport: "JSONRPC",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
      skills: [{ id: provider.name, name: provider.name, description: provider.description, tags: [tag] }],
    }));
    target.post("/" + provider.id + "/a2a", async (request, reply) => {
      const message = request.body?.params?.message;
      if (request.body?.method !== "message/send" || message?.kind !== "message"
        || message.role !== "user" || !message.messageId) {
        return reply.code(400).send({ error: "Use A2A 0.3 message/send with a user Message." });
      }
      const part = message.parts?.find((part) => part.kind === "data");
      const result = execute(provider, part?.data);
      return { jsonrpc: "2.0", id: request.body.id, result: {
        kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "data", data: result }],
      } };
    });
  }
}

const summary = { startedAt: new Date().toISOString(), agent: "codex", clientVersion: version, model: values.model, workflow: values.workflow,
  requestedTargets: count, candidateTargets: candidates.length, decoyTargets: 2, passed: false };
try {
  // 1. Register independent targets; configure only the hub in the consumer's MCP settings.
  targetUrl = await target.listen({ host: "127.0.0.1", port: 0 });
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
  const admin = new HubClient(hubUrl, tokens.admin);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (const provider of shuffled) {
    await admin.create({ id: provider.id, name: provider.id, description: provider.description,
      protocol: provider.protocol, tags: [summaryBatch && provider.decoy && provider.protocol === "mcp" ? "unrelated" : tag],
      capabilities: [{ name: provider.name, description: provider.description, inputSchema: schema }],
      connection: { transport: provider.protocol === "mcp" ? "streamable-http" : "http",
        url: targetUrl + "/" + provider.id + "/" + provider.protocol,
        ...(provider.protocol === "a2a" ? { agentCardUrl: targetUrl + "/" + provider.id + "/agent-card.json", protocolVersion: "0.3.0", protocolBinding: "JSONRPC" } : {}),
        auth: summaryBatch && provider.decoy && provider.protocol === "a2a" ? { type: "none" }
          : { type: "bearer", envVars: ["TCDH_SELECTION_TARGET_TOKEN"] } } });
  }
  const tasks = candidates.filter((item) => item.selected).map((item) => ({ goal: item.description, input: item.input }));
  const discovery = summaryBatch
    ? `Use one search_targets call with view "summary", tag "${tag}", auth "bearer", and inputs true. Use capability summaries to choose targets, then call get_targets once with exactly the selected IDs and use its full metadata.`
    : `Search the registry using tag ${tag}; unrelated providers are present. Select from capability descriptions, and use get_target for current connection details for every chosen target.`;
  const prompt = `Use the connected agent_tcdh hub to choose the read-only providers needed for these tasks: ${JSON.stringify(tasks)}.
${discovery} Do not invoke unrelated providers. Execute every requested task directly against its chosen MCP server or A2A agent. Target URLs must come only from hub responses. Read authentication from the environment variable referenced in connection.auth.envVars without printing it. Pass challenge ${challenge} and the task's input unchanged. MCP arguments and A2A data parts use {challenge,input}. Fetch each A2A Agent Card and follow its declared wire protocol. You may use shell HTTP clients when native tools cannot connect directly. Do not change personal or MCP configuration, access files outside this workspace, invoke additional models or subagents, or contact any network other than the hub and targets. Return only JSON: {"results":[{"targetId":"...","task":"capability name","protocol":"mcp or a2a","value":"actual value (preserve JSON type)","receipt":"actual server receipt"}]}. Never invent receipts or substitute your own computation for target execution.`;
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json",
    "--model", values.model, "--sandbox", "workspace-write", "-c", "approval_policy=\"never\"",
    "-c", "sandbox_workspace_write.network_access=true", "-c", "model_reasoning_effort=\"medium\"",
    "-c", "mcp_servers.agent_tcdh.url=" + JSON.stringify(hubUrl + "/mcp"),
    "-c", "mcp_servers.agent_tcdh.bearer_token_env_var=\"TCDH_SELECTION_READ_TOKEN\"",
    "-c", "mcp_servers.agent_tcdh.default_tools_approval_mode=\"approve\"", prompt];
  console.log(JSON.stringify({ phase: "running", output: directory, count, model: values.model }));
  child = spawn("codex", args, { cwd: workspace, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PWD: workspace, TCDH_SELECTION_READ_TOKEN: tokens.read, TCDH_SELECTION_TARGET_TOKEN: tokens.target } });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  timer = setTimeout(() => stopProcessTree(child), 300_000);
  summary.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  // 2. Compare the consumer's selected results with unpredictable receipts issued by the targets.
  const messages = stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.type === "item.completed" && event.item?.type === "agent_message" ? [event.item.text] : [];
    } catch {
      return [];
    }
  });
  const hubCalls = events.filter((event) => event.source === "hub" && event.method === "tools/call");
  summary.hubSearchCalls = hubCalls.filter((event) => event.tool === "search_targets").length;
  summary.hubGetCalls = hubCalls.filter((event) => event.tool === "get_target").length;
  summary.executions = executions;
  const attempts = events.filter((event) => event.source === "target"
    && ["tools/call", "message/send"].includes(event.method));
  const selectedIds = new Set(candidates.filter((item) => item.selected).map((item) => item.id));
  summary.unrelatedExecutionAttempts = attempts.filter((event) => !selectedIds.has(event.path.split("/")[1])).length;
  if (summaryBatch) {
    auditSummaryBatch(hubCalls, [...selectedIds], tag, summary);
  } else {
    assert.ok(summary.hubSearchCalls > 0 && summary.hubGetCalls >= count, "The consumer must discover and retrieve its chosen targets.");
  }
  assert.equal(summary.unrelatedExecutionAttempts, 0, "An unrelated target received an execution request.");
  assert.equal(attempts.length, count, "Each selected target must receive exactly one execution request.");
  assert.equal(summary.exitCode, 0, "The Codex process failed.");
  summary.final = JSON.parse(messages.at(-1) ?? "null");
  assert.equal(summary.final?.results?.length, count);
  assert.equal(executions.length, count, "Each selected provider must execute exactly once.");
  for (const provider of candidates.filter((item) => item.selected)) {
    const actual = executions.find((item) => item.targetId === provider.id);
    assert.ok(actual, "A requested provider was not executed.");
    if (!summaryBatch) {
      assert.ok(hubCalls.some((event) => event.tool === "get_target" && event.targetId === provider.id), "A selected provider was not retrieved through get_target.");
    }
    if (provider.protocol === "a2a") {
      assert.ok(events.some((event) => event.source === "target" && event.path === "/" + provider.id + "/agent-card.json"), "A selected A2A Agent Card was not read.");
    }
    assert.deepEqual(summary.final.results.find((item) => item.targetId === provider.id), actual);
  }
  summary.mcpExecutions = executions.filter((item) => item.protocol === "mcp").length;
  summary.a2aExecutions = executions.filter((item) => item.protocol === "a2a").length;
  if (count > 1) {
    assert.ok(summary.mcpExecutions > 0 && summary.a2aExecutions > 0);
  }
  summary.passed = true;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  // 3. Persist evidence and stop only processes owned by this verification.
  clearTimeout(timer);
  if (child?.pid) {
    stopProcessTree(child);
  }
  summary.finishedAt = new Date().toISOString();
  await writeFile(join(directory, "stdout.jsonl"), redact(stdout));
  await writeFile(join(directory, "stderr.log"), redact(stderr));
  await writeFile(join(directory, "events.json"), redact(JSON.stringify(events, null, 2)) + "\n");
  await writeFile(join(directory, "summary.json"), redact(JSON.stringify(summary, null, 2)) + "\n");
  await hub.close();
  await target.close();
  console.log(redact(JSON.stringify(summary, null, 2)));
}
