import { AgentCard } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DiscoveryReader } from "./mcp.js";
import { httpUrl, searchSchema } from "./targets/schema.js";
import {
  createA2aDiscoveryHandler, createHubAgentCard, discoveryCommandSchema, legacyHubAgentCard,
} from "./a2a-discovery.js";
import type { DiscoveryCommand } from "./a2a-discovery.js";

export const publicUrlSchema = httpUrl.refine((value) => {
  try {
    const url = new URL(value);
    return !url.href.includes("?") && !url.href.includes("#");
  } catch {
    return false;
  }
}, "The public URL must not contain a query or fragment.");
const envelopeSchema = z.looseObject({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int(), z.null()]),
  method: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}),
});
const messageSchema = z.looseObject({
  messageId: z.string().min(1).max(200), role: z.string(),
  contextId: z.string().max(200).optional(), taskId: z.string().optional(),
  referenceTaskIds: z.array(z.string()).optional(),
  parts: z.array(z.record(z.string(), z.unknown())).length(1),
});
const unsupportedMethods: Record<string, number> = {
  SendStreamingMessage: -32004, SubscribeToTask: -32004, ListTasks: -32004,
  GetTask: -32001, CancelTask: -32001,
  CreateTaskPushNotificationConfig: -32003, GetTaskPushNotificationConfig: -32003,
  ListTaskPushNotificationConfigs: -32003, DeleteTaskPushNotificationConfig: -32003,
  GetExtendedAgentCard: -32007,
};
const legacyUnsupportedMethods: Record<string, number> = {
  "message/stream": -32004, "tasks/resubscribe": -32004,
  "tasks/get": -32001, "tasks/cancel": -32001,
  "tasks/pushNotificationConfig/set": -32003, "tasks/pushNotificationConfig/get": -32003,
  "tasks/pushNotificationConfig/list": -32003, "tasks/pushNotificationConfig/delete": -32003,
  "agent/getAuthenticatedExtendedCard": -32007,
};

/** Build a JSON-RPC error without reflecting request bodies or credentials. */
function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Validate a single discovery message before the SDK coerces input values. */
function readCommand(params: Record<string, unknown>, legacy: boolean): {
  command?: DiscoveryCommand; textOutput?: boolean; error?: { code: number; message: string };
} {
  // 1. Validate the sender, context, and single input part.
  const parsed = messageSchema.safeParse(params.message);
  if (!parsed.success || parsed.data.role !== (legacy ? "user" : "ROLE_USER")
    || (legacy && parsed.data.kind !== "message")) {
    return { error: { code: -32602, message: "Send a user message with exactly one text or data part." } };
  }
  const message = parsed.data;
  if (message.taskId || message.referenceTaskIds?.length) {
    return { error: { code: -32001, message: "This hub has no stored A2A tasks." } };
  }
  const part = message.parts[0]!;
  const keys = ["text", "data", "raw", "url", "file"].filter((key) => Object.hasOwn(part, key));
  if (keys.length !== 1 || !["text", "data"].includes(keys[0]!)
    || (legacy && part.kind !== keys[0])
    || (part.mediaType !== undefined && part.mediaType !== (keys[0] === "text" ? "text/plain" : "application/json"))) {
    return { error: { code: -32005, message: "Exactly one text/plain or application/json part is supported." } };
  }

  // 2. Accept only keyword or structured queries, excluding mutations and execution commands.
  const command = keys[0] === "text"
    ? discoveryCommandSchema.safeParse({ operation: "search_targets", arguments: { q: part.text } })
    : discoveryCommandSchema.safeParse(part.data);
  if (!command.success) {
    return { error: { code: -32602, message: "Use search_targets, get_target, or get_targets with valid arguments." } };
  }
  if (keys[0] === "text" && (typeof part.text !== "string" || !searchSchema.safeParse({ q: part.text }).success)) {
    return { error: { code: -32602, message: "Search text must be a string of at most 500 characters." } };
  }

  // 3. Check the output media type and reject push settings for immediate responses.
  const configuration = z.looseObject({
    acceptedOutputModes: z.array(z.string()).optional(),
    blocking: z.boolean().optional(), returnImmediately: z.boolean().optional(),
  }).optional().safeParse(params.configuration);
  if (!configuration.success) {
    return { error: { code: -32602, message: "Check the configuration format." } };
  }
  if (configuration.data?.pushNotificationConfig !== undefined) {
    return { error: { code: -32003, message: "Push notifications are not supported." } };
  }
  const modes = configuration.data?.acceptedOutputModes;
  if (modes?.length && !modes.some((mode) => ["text/plain", "application/json"].includes(mode))) {
    return { error: { code: -32005, message: "Choose application/json or text/plain output." } };
  }
  return { command: command.data, textOutput: Boolean(modes?.length && !modes.includes("application/json")) };
}

/** Use the configured public URL or actual listener address without trusting Host headers. */
function publicBaseUrl(app: FastifyInstance, configured?: string): string {
  if (configured) {
    return new URL(configured).href.replace(/\/+$/, "");
  }
  const address = app.server.address();
  if (address && typeof address === "object") {
    const host = ["0.0.0.0", "::"].includes(address.address) ? "127.0.0.1" : address.address;
    return "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + address.port;
  }
  return "http://127.0.0.1:3000";
}

/** Connect A2A discovery cards and immediate queries to existing permissions and storage. */
export function registerA2aDiscovery(
  app: FastifyInstance, reader: DiscoveryReader,
  options: { authEnabled: boolean; publicUrl?: string | undefined; allowedOrigins?: readonly string[] | undefined },
): void {
  // 1. Validate browser origins and protocol versions before parsing the body.
  const configured = options.publicUrl === undefined ? undefined : publicUrlSchema.parse(options.publicUrl);
  app.addHook("onRequest", async (request, reply) => {
    if (!["/a2a", "/.well-known/agent-card.json"].includes(request.routeOptions.url ?? "")) {
      return;
    }
    reply.header("Cache-Control", "no-store").header("Vary", "A2A-Version");
    const origin = request.headers.origin;
    if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) {
      return reply.code(403).send(rpcError(null, -32000, "Origin is not allowed."));
    }
    const version = request.headers["a2a-version"] || "0.3";
    if (typeof version !== "string" || !["1.0", "0.3", "0.3.0"].includes(version)) {
      return reply.code(400).send(rpcError(null, -32009, "Supported A2A versions are 1.0, 0.3, and 0.3.0."));
    }
    reply.header("A2A-Version", version);
  });

  // 2. Publish capabilities and authentication requirements without target lists or secrets.
  app.get("/.well-known/agent-card.json", { config: { access: "public" } }, async (request) => {
    const card = createHubAgentCard(publicBaseUrl(app, configured), options.authEnabled);
    return request.headers["a2a-version"] === "1.0" ? AgentCard.toJSON(card) : legacyHubAgentCard(card);
  });

  // 3. Execute validated queries with the SDK transport matching the requested version.
  app.post("/a2a", {
    config: { access: "read" },
    errorHandler: (error, request, reply) => {
      const status = error.statusCode ?? 500;
      if (status >= 500) {
        request.log.error({ err: error }, "A2A request failed");
      }
      return reply.code(status).send(rpcError(null,
        error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? -32700 : status >= 500 ? -32603 : -32600,
        status >= 500 ? "Unable to process the A2A request." : "Check the A2A request format."));
    },
  }, async (request, reply) => {
    const envelope = envelopeSchema.safeParse(request.body);
    if (!envelope.success) {
      return reply.code(400).send(rpcError(null, -32600, "A single JSON-RPC request with an id is required."));
    }
    const body = envelope.data;
    const legacy = request.headers["a2a-version"] !== "1.0";
    const unsupported = Object.hasOwn(legacy ? legacyUnsupportedMethods : unsupportedMethods, body.method)
      ? (legacy ? legacyUnsupportedMethods : unsupportedMethods)[body.method] : undefined;
    if (unsupported !== undefined) {
      return rpcError(body.id, unsupported, "This hub supports immediate queries, without tasks, streams, push notifications, or extended cards.");
    }
    if (body.params.tenant) {
      return rpcError(body.id, -32004, "Tenant selection is not supported.");
    }
    const selected = body.method === (legacy ? "message/send" : "SendMessage")
      ? readCommand(body.params, legacy) : {};
    if (selected.error) {
      return rpcError(body.id, selected.error.code, selected.error.message);
    }
    const card = createHubAgentCard(publicBaseUrl(app, configured), options.authEnabled);
    const handler = createA2aDiscoveryHandler(reader, card, selected.command, selected.textOutput);
    const transport = legacy ? new LegacyJsonRpcTransportHandler(handler) : new JsonRpcTransportHandler(handler);
    const context = new ServerCallContext({ requestedVersion: legacy ? "0.3" : "1.0" });
    const result = await transport.handle(body, context);
    if (Symbol.asyncIterator in result) {
      try {
        await result.next();
      } catch {
        return rpcError(body.id, -32004, "This hub only supports immediate message responses.");
      } finally {
        await result.return();
      }
      return rpcError(body.id, -32004, "This hub only supports immediate message responses.");
    }
    if (result.error && typeof result.error === "object" && "code" in result.error && result.error.code === -32603) {
      return rpcError(body.id, -32603, "Unable to process the A2A request.");
    }
    return result;
  });
}
