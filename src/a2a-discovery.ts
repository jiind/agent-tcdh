import { randomUUID } from "node:crypto";
import { AgentCard, Message } from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError,
  TaskNotFoundError, UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { z } from "zod";
import { PACKAGE_VERSION } from "./version.js";
import { HubError } from "./errors.js";
import type { DiscoveryReader } from "./mcp.js";
import { discoverySearchSchema, targetIdSchema, targetLookupSchema } from "./targets/schema.js";

export const discoveryCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("search_targets"), arguments: discoverySearchSchema.prefault({}) }),
  z.strictObject({ operation: z.literal("get_target"), arguments: z.strictObject({ id: targetIdSchema }) }),
  z.strictObject({ operation: z.literal("get_targets"), arguments: targetLookupSchema }),
]);
export type DiscoveryCommand = z.infer<typeof discoveryCommandSchema>;

/** Describe discovery capabilities and direct connections in an A2A card. */
export function createHubAgentCard(baseUrl: string, authEnabled: boolean): AgentCard {
  // 1. Publish the query format and supported protocol versions.
  const card = AgentCard.fromJSON({
    name: "AgentTCDH", version: PACKAGE_VERSION,
    description: "Find capabilities and connection details for registered MCP servers and A2A agents. "
      + "A text part is used as a literal keyword query; a data part uses {operation, arguments}. "
      + "Connect directly using the returned connection. Conversation history and long-running tasks are not stored.",
    supportedInterfaces: ["1.0", "0.3", "0.3.0"].map((protocolVersion) => ({
      url: baseUrl + "/a2a", protocolBinding: "JSONRPC", protocolVersion,
    })),
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: [
      { id: "search_targets", name: "Search targets", tags: ["discovery", "mcp", "a2a"],
        description: "data: {operation: 'search_targets', arguments: {q?, match?, view?, suggest?, protocol?, transport?, auth?, tag?, includeDisabled?, limit?, offset?, cursor?, explain?, inputs?, freshness?, withFreshness?, staleHours?}}. "
          + "Use summary view with inputs=true to compare required parameters, explain=true for match and filter details, and cursor='start' for change-aware pagination. A text part contains search keywords.",
        examples: ["document search", '{"operation":"search_targets","arguments":{"protocol":"a2a"}}'] },
      { id: "get_target", name: "Get connection details", tags: ["discovery", "connection"],
        description: "data: {operation: 'get_target', arguments: {id}}. Returns current connection details.",
        examples: ['{"operation":"get_target","arguments":{"id":"docs"}}'] },
      { id: "get_targets", name: "Get connections for selected targets", tags: ["discovery", "connection"],
        description: "data: {operation: 'get_targets', arguments: {ids}}. Returns up to ten selected targets in request order, using null for missing targets.",
        examples: ['{"operation":"get_targets","arguments":{"ids":["docs","research"]}}'] },
    ],
  });

  // 2. Advertise Bearer authentication without revealing token values.
  if (authEnabled) {
    const secured = AgentCard.fromJSON({
      ...AgentCard.toJSON(card) as Record<string, unknown>,
      securitySchemes: { hubBearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
      securityRequirements: [{ schemes: { hubBearer: { list: [] } } }],
    });
    return secured;
  }
  return card;
}

/** Build a 0.3 card with the same capabilities and authentication requirements. */
export function legacyHubAgentCard(card: AgentCard): Record<string, unknown> {
  const json = AgentCard.toJSON(card) as Record<string, unknown>;
  return {
    name: card.name, description: card.description, version: card.version,
    protocolVersion: "0.3.0", url: card.supportedInterfaces[0]!.url, preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: card.defaultInputModes, defaultOutputModes: card.defaultOutputModes,
    skills: json.skills, supportsAuthenticatedExtendedCard: false,
    ...(Object.keys(card.securitySchemes).length ? {
      securitySchemes: { hubBearer: { type: "http", scheme: "bearer" } }, security: [{ hubBearer: [] }],
    } : {}),
  };
}

/** Reject task operations because this hub does not store A2A tasks. */
async function missingTask(): Promise<never> {
  throw new TaskNotFoundError("This hub has no stored A2A tasks.");
}

/** Reject unsupported push notification settings. */
async function noPush(): Promise<never> {
  throw new PushNotificationNotSupportedError("Push notifications are not supported.");
}

/** Reject unsupported streaming and task subscriptions. */
async function* noStream(): AsyncGenerator<never, void, undefined> {
  throw new UnsupportedOperationError("This hub only supports immediate message responses.");
}

/** Report that no authenticated extended card is configured. */
async function noExtendedCard(): Promise<never> {
  throw new ExtendedAgentCardNotConfiguredError("No authenticated extended card is configured.");
}

/** Report that immediate responses do not include a task list. */
async function noTaskList(): Promise<never> {
  throw new UnsupportedOperationError("Task listing is not supported.");
}

/** Connect a validated discovery command to the shared reader through the A2A SDK. */
export function createA2aDiscoveryHandler(
  reader: DiscoveryReader, card: AgentCard, command?: DiscoveryCommand, textOutput = false,
): A2ARequestHandler {
  return {
    /** Return the public discovery card. */
    async getAgentCard() {
      return card;
    },
    getAuthenticatedExtendedAgentCard: noExtendedCard,
    /** Return current registry data as an independent A2A message. */
    async sendMessage(params, _context: ServerCallContext) {
      // 1. Execute the validated query and include only application errors in the result.
      if (!command) {
        throw new Error("No validated discovery command was provided.");
      }
      let result: unknown;
      try {
        switch (command.operation) {
          case "search_targets": result = await reader.search(command.arguments); break;
          case "get_target": result = await reader.get(command.arguments.id); break;
          case "get_targets": result = await reader.getMany(command.arguments.ids); break;
        }
      } catch (error) {
        if (!(error instanceof HubError)) {
          throw new Error("Unable to complete the hub query.");
        }
        result = { error: { code: error.code, message: error.message } };
      }

      // 2. Build the requested output format and let the SDK serialize each version.
      return Message.fromJSON({
        messageId: randomUUID(), contextId: params.message?.contextId || randomUUID(), role: "ROLE_AGENT",
        parts: [textOutput ? { text: JSON.stringify(result), mediaType: "text/plain" }
          : { data: result, mediaType: "application/json" }],
      });
    },
    sendMessageStream: noStream, resubscribe: noStream,
    getTask: missingTask, cancelTask: missingTask, listTasks: noTaskList,
    createTaskPushNotificationConfig: noPush, getTaskPushNotificationConfig: noPush,
    listTaskPushNotificationConfigs: noPush, deleteTaskPushNotificationConfig: noPush,
  };
}
