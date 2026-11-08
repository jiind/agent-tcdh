import { z } from "zod";
import { freshnessQuerySchema, historyIdSchema, historyQuerySchema, observationSchema } from "./registry/activity.js";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { HubError } from "./errors.js";
import { TargetStore } from "./targets/store.js";
import { searchQuerySchema, targetDefinitionSchema, targetIdSchema } from "./targets/schema.js";
import { registerHttpDiscovery } from "./mcp-http.js";
import { createOpenApiDocument } from "./openapi.js";
import { importQuerySchema, MAX_SNAPSHOT_BYTES, parseSnapshot } from "./registry/schema.js";
import { hubAuthSchema, registerAccessControl } from "./auth.js";
import { entityTag, parseIfMatch } from "./targets/version.js";
import { publicUrlSchema, registerA2aDiscovery } from "./a2a-http.js";

export interface AppOptions {
  dbPath?: string;
  token?: string;
  readToken?: string;
  logger?: FastifyServerOptions["logger"];
  allowedOrigins?: string[];
  publicUrl?: string;
}

/** Create the registry and discovery HTTP API with validation, authentication, and storage. */
export function createApp(options: AppOptions = {}): FastifyInstance {
  // 1. Validate authentication before creating the server and storage.
  const auth = hubAuthSchema.parse({ token: options.token, readToken: options.readToken });
  const publicUrl = options.publicUrl === undefined ? undefined : publicUrlSchema.parse(options.publicUrl);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 1_048_576 });
  registerAccessControl(app, auth);
  const store = new TargetStore(options.dbPath ?? ":memory:");
  app.addHook("onClose", async () => {
    store.close();
  });

  // 2. Translate input, application, and server failures into consistent responses.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_INPUT",
          message: "Check the request format.",
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
      });
    }
    if (error instanceof HubError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      ? error.statusCode : undefined;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: { code: "INVALID_REQUEST", message: "Check the request format." },
      });
    }
    request.log.error({ err: error }, "Hub request failed");
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "Unable to process the request." },
    });
  });

  // 3. Register routes with explicit read or administrator access.
  app.get("/health", { config: { access: "public" } }, async () => {
    return { status: "ok" };
  });
  const openapi = createOpenApiDocument(Boolean(options.token));
  app.get("/openapi.json", { config: { access: "read" } }, async () => {
    return openapi;
  });
  app.get("/api/registry/export", { config: { access: "admin" } }, async (_request, reply) => {
    const snapshot = store.exportSnapshot();
    return reply.header("Content-Disposition", 'attachment; filename="agent-tcdh-registry.json"')
      .send(snapshot);
  });
  app.post("/api/registry/import", { bodyLimit: MAX_SNAPSHOT_BYTES, config: { access: "admin" } }, async (request) => {
    return store.importSnapshot(parseSnapshot(request.body), importQuerySchema.parse(request.query));
  });
  app.get("/api/registry/history", { config: { access: "admin" } }, async (request) => {
    return store.activity.history(historyQuerySchema.parse(request.query));
  });
  app.get<{ Params: { id: string } }>("/api/registry/history/:id", { config: { access: "admin" } }, async (request) => {
    const { afterRevision: _revision, ...event } = store.activity.event(historyIdSchema.parse(request.params.id));
    return event;
  });
  app.post<{ Params: { id: string } }>("/api/registry/history/:id/undo", { config: { access: "admin" } }, async (request) => {
    const body = z.object({ apply: z.boolean().default(false) }).strict().parse(request.body);
    return store.undoHistory(historyIdSchema.parse(request.params.id), body.apply);
  });
  app.get("/api/registry/freshness", { config: { access: "read" } }, async (request) => {
    return store.activity.freshness(freshnessQuerySchema.parse(request.query));
  });
  app.post<{ Params: { id: string } }>("/api/targets/:id/observation", { config: { access: "admin" } }, async (request) => {
    const condition = parseIfMatch(request.headers["if-match"]);
    if (condition?.kind !== "tags" || condition.tags.length !== 1) {
      throw new HubError(400, "OBSERVATION_VERSION_REQUIRED", "Provide a single strong If-Match target version.");
    }
    return store.activity.observe(targetIdSchema.parse(request.params.id), entityTag(condition.tags[0]!), observationSchema.parse(request.body));
  });
  app.post("/api/targets", { config: { access: "admin" } }, async (request, reply) => {
    const result = store.createVersioned(targetDefinitionSchema.parse(request.body));
    return reply.code(201).header("ETag", result.etag)
      .header("Location", "/api/targets/" + result.target.id).send(result.target);
  });
  app.get("/api/targets", { config: { access: "read" } }, async (request) => {
    return store.search(searchQuerySchema.parse(request.query));
  });
  app.get<{ Params: { id: string } }>("/api/targets/:id", { config: { access: "read" } }, async (request, reply) => {
    const result = store.getVersioned(targetIdSchema.parse(request.params.id));
    return reply.header("ETag", result.etag).header("Cache-Control", "no-store").send(result.target);
  });
  app.put<{ Params: { id: string } }>("/api/targets/:id", { config: { access: "admin" } }, async (request, reply) => {
    const result = store.updateVersioned(
      targetIdSchema.parse(request.params.id),
      targetDefinitionSchema.parse(request.body),
      parseIfMatch(request.headers["if-match"]),
    );
    return reply.header("ETag", result.etag).send(result.target);
  });
  app.delete<{ Params: { id: string } }>("/api/targets/:id", { config: { access: "admin" } }, async (request, reply) => {
    store.remove(targetIdSchema.parse(request.params.id), parseIfMatch(request.headers["if-match"]));
    return reply.code(204).send();
  });
  registerHttpDiscovery(app, store, options.allowedOrigins);
  registerA2aDiscovery(app, store, {
    authEnabled: Boolean(auth.token), publicUrl, allowedOrigins: options.allowedOrigins,
  });

  return app;
}
