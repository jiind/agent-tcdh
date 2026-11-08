import type { z } from "zod";
import type { RegistryActivity, freshnessQuerySchema, historyQuerySchema, observationSchema } from "./registry/activity.js";
import type { SearchOptions, SearchResult, Target, TargetDefinition } from "./targets/schema.js";
import type { ImportOptions, ImportResult, RegistrySnapshot } from "./registry/schema.js";
import { hubTokenSchema } from "./auth.js";
import { entityTag, parseIfMatch } from "./targets/version.js";
import type { VersionedTarget } from "./targets/version.js";

/** Share the registry and discovery HTTP API between CLI and MCP clients. */
export class HubClient {
  private readonly baseUrl: URL;

  /** Store the hub URL and optional authentication token. */
  constructor(hub: string, private readonly token?: string) {
    // 1. Validate tokens before HTTP library errors can expose their values.
    if (token && !hubTokenSchema.safeParse(token).success) {
      throw new Error("Hub tokens must be ASCII strings without whitespace or control characters.");
    }

    // 2. Validate the URL scheme and reject embedded credentials.
    this.baseUrl = new URL(hub.endsWith("/") ? hub : hub + "/");
    if (!["http:", "https:"].includes(this.baseUrl.protocol)
      || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error("Hub URLs must use HTTP(S) without credentials, queries, or fragments.");
    }
  }

  /** Encode search options as query parameters and retrieve current targets. */
  async search(options: SearchOptions): Promise<SearchResult> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== "") {
        query.set(key, String(value));
      }
    }

    return this.request<SearchResult>("api/targets?" + query.toString());
  }

  /** Retrieve a target's current capabilities and connection details. */
  async get(id: string): Promise<Target> {
    return this.request<Target>("api/targets/" + encodeURIComponent(id));
  }

  /** Retrieve the target and its strong version together. */
  async getVersioned(id: string): Promise<VersionedTarget> {
    // 1. Read the response body and version header from the same response.
    const response = await this.send("api/targets/" + encodeURIComponent(id));
    const target = await response.json() as Target;
    const etag = response.headers.get("etag");
    if (!etag) {
      throw new Error("The hub did not provide a target version. Upgrade the server.");
    }

    // 2. Accept only a single strong ETag for conditional writes.
    const condition = parseIfMatch(etag);
    if (condition?.kind !== "tags" || condition.tags.length !== 1
      || entityTag(condition.tags[0]!) !== etag.trim()) {
      throw new Error("The hub returned an invalid target version.");
    }

    return { target, etag };
  }

  /** Register a validated target definition. */
  async create(target: TargetDefinition): Promise<Target> {
    return this.request<Target>("api/targets", "POST", target);
  }

  /** Replace the complete definition of an existing target. */
  async update(id: string, target: TargetDefinition, ifMatch?: string): Promise<Target> {
    return this.request<Target>("api/targets/" + encodeURIComponent(id), "PUT", target, ifMatch);
  }

  /** Replace a definition and return the exact committed revision for subsequent observation recording. */
  async updateVersioned(id: string, target: TargetDefinition, ifMatch: string): Promise<VersionedTarget> {
    const response = await this.send("api/targets/" + encodeURIComponent(id), "PUT", target, ifMatch);
    const etag = response.headers.get("etag");
    const condition = parseIfMatch(etag ?? undefined);
    if (condition?.kind !== "tags" || condition.tags.length !== 1 || entityTag(condition.tags[0]!) !== etag) {
      throw new Error("The hub did not provide a valid committed version. The update may already have completed.");
    }
    return { target: await response.json() as Target, etag };
  }

  /** Remove a target from the registry. */
  async remove(id: string, ifMatch?: string): Promise<void> {
    await this.request<void>("api/targets/" + encodeURIComponent(id), "DELETE", undefined, ifMatch);
  }

  /** Export all registered definitions, including disabled targets. */
  async exportRegistry(): Promise<RegistrySnapshot> {
    return this.request<RegistrySnapshot>("api/registry/export");
  }

  /** Apply or preview a snapshot using the selected conflict policy. */
  async importRegistry(snapshot: RegistrySnapshot, options: ImportOptions): Promise<ImportResult> {
    const query = new URLSearchParams({
      onConflict: options.onConflict, dryRun: String(options.dryRun),
    });
    return this.request<ImportResult>("api/registry/import?" + query.toString(), "POST", snapshot);
  }

  /** Read retained administrator change summaries. */
  async history(query: z.infer<typeof historyQuerySchema>) {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string]));
    return this.request<ReturnType<RegistryActivity["history"]>>("api/registry/history?" + params);
  }

  /** Retrieve full definitions for one retained administrator event. */
  async historyEvent(id: number) {
    return this.request<Omit<ReturnType<RegistryActivity["event"]>, "afterRevision">>("api/registry/history/" + id);
  }

  /** Preview or conditionally apply the inverse of the latest change. */
  async undoHistory(id: number, apply = false) {
    return this.request<ReturnType<RegistryActivity["undo"]>>("api/registry/history/" + id + "/undo", "POST", { apply });
  }

  /** Read revision-bound metadata observations without inspecting providers. */
  async freshness(query: z.infer<typeof freshnessQuerySchema>) {
    return this.request<ReturnType<RegistryActivity["freshness"]>>("api/registry/freshness?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])));
  }

  /** Persist a consumer metadata result against its exact observed definition. */
  async observe(id: string, observation: z.infer<typeof observationSchema>, etag: string) {
    return this.request<ReturnType<RegistryActivity["observe"]>>("api/targets/" + encodeURIComponent(id) + "/observation", "POST", observation, etag);
  }

  /** Decode a shared HTTP response into the requested result type. */
  private async request<T>(path: string, method = "GET", body?: unknown, ifMatch?: string): Promise<T> {
    const response = await this.send(path, method, body, ifMatch);
    if (response.status === 204) {
      return undefined as T;
    }

    return await response.json() as T;
  }

  /** Apply authentication, conditions, and timeouts before translating HTTP failures. */
  private async send(path: string, method = "GET", body?: unknown, ifMatch?: string): Promise<Response> {
    // 1. Build the request headers and optional body.
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) {
      headers.Authorization = "Bearer " + this.token;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (ifMatch !== undefined) {
      parseIfMatch(ifMatch);
      headers["If-Match"] = ifMatch;
    }

    // 2. Send the request and interpret the response status.
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined) as
        { error?: { code?: string; message?: string } } | undefined;
      throw new Error(
        "HTTP " + response.status + " "
        + (detail?.error?.code ?? "REQUEST_FAILED") + ": "
        + (detail?.error?.message ?? "Hub request failed."),
      );
    }

    return response;
  }
}
