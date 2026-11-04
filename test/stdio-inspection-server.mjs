import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "normal";
const events = process.env.INSPECTION_EVENTS;

/** Record local fixture effects without sending them over the MCP metadata channel. */
function record(value) {
  if (events) {
    appendFileSync(events, JSON.stringify(value) + "\n");
  }
}

record({ event: "started", pid: process.pid, cwd: process.cwd(), token: process.env.INSPECTION_TOKEN,
  hubTokenInherited: Boolean(process.env.AGENT_TCDH_TOKEN), args: process.argv.slice(3) });
if (mode === "descendant" || mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  record({ event: "descendant", pid: child.pid });
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "bad-json") {
  process.stdout.write("private-protocol-output is not JSON\n");
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  process.stderr.write("private-stderr-output".repeat(4000));
  setInterval(() => {}, 1000);
} else {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "inspection-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    record({ event: "listed" });
    const tools = Array.from({ length: mode === "oversized" ? 201 : 1 }, (_, index) => ({
      name: "read_metadata_" + index, description: "Fixture metadata", inputSchema: { type: "object" },
    }));
    return { tools, ...(mode === "cursor" ? { nextCursor: "repeat" } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async () => {
    record({ event: "tool-called" });
    throw new Error("Tool execution is outside the fixture's metadata contract.");
  });
  await server.connect(new StdioServerTransport());
}
