// Non-English fixtures exercise canonical Unicode and mixed-language searches.
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { TargetStore } from "../dist/targets/store.js";

const cases = [
  { group: "exact", q: "deploy-audit", ids: ["deploy-audit"] },
  { group: "exact", q: "Release Notes", ids: ["release-editor"] },
  { group: "capability", q: "invoice export", ids: ["finance"] },
  { group: "capability", q: "queue metrics", ids: ["ops-queue"] },
  { group: "normalized", q: "support_ticket", ids: ["support-intake"] },
  { group: "normalized", q: "cafe\u0301 가이드", ids: ["coffee-guide"] },
  { group: "normalized", q: "배포_가이드", ids: ["deployment-guide"] },
  { group: "normalized", q: "backup restore", ids: ["backup"] },
  { group: "filters", q: "invoice export", protocol: "a2a", tag: "billing", ids: ["billing-agent"] },
  { group: "filters", q: "invoice export", tag: "legacy", includeDisabled: true, ids: ["legacy-export"] },
  { group: "no-answer", q: "maritime whale census", ids: [] },
  { group: "no-answer", q: "invoice export", tag: "legacy", ids: [] },
  { group: "no-answer", q: "support ticket refund", ids: [] },
  { group: "no-answer", q: "_--_", ids: [] },
];

const targets = [
  { id: "deploy-audit", name: "Change verifier", description: "Review deployment approvals." },
  { id: "release-editor", name: "Release Notes", description: "Draft a changelog from accepted changes." },
  { id: "finance", name: "Billing data", capabilities: [{ name: "invoice export", description: "Export invoices to a spreadsheet." }] },
  { id: "ops-queue", name: "Queue metrics dashboard", capabilities: [{ name: "queue metrics", description: "Read queue latency and depth." }] },
  { id: "support-intake", name: "Support ticket", description: "Create a customer issue." },
  { id: "coffee-guide", name: "Café 가이드", description: "Browse a coffee reference." },
  { id: "deployment-guide", name: "배포 가이드", description: "Browse release procedures." },
  { id: "backup", name: "Recovery console", capabilities: [{ name: "backup_restore", description: "Recover an archived configuration." }] },
  { id: "billing-agent", name: "Billing agent", protocol: "a2a", tags: ["billing"],
    capabilities: [{ name: "invoice export", description: "Respond with billing records." }] },
  { id: "legacy-export", name: "Legacy invoice export", enabled: false, tags: ["legacy"] },
];

const capabilityCases = [
  { q: "warehouse stock reserve", id: "hold-inventory", name: "reserve_stock", description: "Hold inventory at the selected warehouse." },
  { q: "tax receipt email", id: "send-receipt", name: "email_receipt", description: "Deliver a tax document to its recipient." },
  { q: "배포 audit 로그", id: "log-tool", name: "audit_events", description: "배포 이력을 검색하고 로그를 내보냅니다." },
  { q: "pdf table extract", id: "table-converter", name: "extract_grid", description: "Turn a table from a PDF into structured rows." },
];

for (const [index, { q, id, name, description }] of capabilityCases.entries()) {
  targets.push({ id, name: "Workflow tool", capabilities: [{ name, description }] });
  const [first, second, last] = q.split(" ");
  for (const area of ["archive", "catalog", "docs", "mirror"]) {
    targets.push({ id: `${area}-workflow-${index}`, name: `${area} ${q} services`, tags: [first, second, last],
      capabilities: [{ name: first, description: `List ${second} references.` }, { name: last, description: "Inspect processing history." }] });
  }
}

for (const name of ["deploy-audit", "release notes", "invoice export"]) {
  const slug = name.replaceAll(" ", "-");
  for (const area of ["archive", "catalog", "docs", "mirror"]) {
    targets.push({ id: `${area}-${slug}`, name: `${area} ${name} index`, description: `Lists ${name} references.`,
      tags: [name], capabilities: [{ name: `describe ${name}`, description: `Return ${name} index metadata.` }] });
  }
}

const catalogAreas = ["calendar", "inventory", "knowledge base", "observability", "projects", "quality", "support", "warehouse"];

/** Fill an in-memory registry with stable catalog entries and lookalikes. */
function populate(store, size) {
  for (let index = 0; index < size; index++) {
    const area = catalogAreas[index % catalogAreas.length];
    const target = targets[index] ?? { id: `fixture-${index}`, name: `${area} integration ${index}`,
      description: `Find ${area} records and documentation.`, tags: [area],
      capabilities: [{ name: "find records", description: `List recent ${area} entries.` }] };
    const protocol = target.protocol ?? "mcp";
    const connection = protocol === "a2a" ? { transport: "http", url: "https://fixture.example/agent" }
      : { transport: "streamable-http", url: "https://fixture.example/mcp" };
    store.create({ description: "Manage records.", tags: [], capabilities: [], enabled: true, ...target, protocol, connection });
  }
}

/** Measure warmed search time and record whether each labeled query found a relevant result. */
function measure(store, options, queryCases = cases) {
  const samples = [];
  const queries = queryCases.map(({ group, ids, ...query }) => ({ group, ids,
    options: { limit: 3, offset: 0, includeDisabled: false, ...query, ...options } }));
  for (let iteration = 0; iteration < 10; iteration++) {
    for (const query of queries) {
      store.search(query.options);
    }
  }
  const outcomes = queries.map(({ group, ids, options: query }) => {
    const result = store.search(query);
    return { group, q: query.q, ...(query.tag ? { tag: query.tag } : {}), expected: ids, total: result.total,
      top3: result.items.map((item) => item.id), hit: result.items.some((item) => ids.includes(item.id)) };
  });
  for (let iteration = 0; iteration < 30; iteration++) {
    for (const query of queries) {
      const start = performance.now();
      store.search(query.options);
      samples.push(performance.now() - start);
    }
  }
  samples.sort((left, right) => left - right);
  const relevant = outcomes.filter((outcome) => outcome.expected.length > 0);
  const noAnswer = outcomes.filter((outcome) => outcome.expected.length === 0);
  return {
    top1: { hits: relevant.filter((outcome) => outcome.expected.includes(outcome.top3[0])).length, queries: relevant.length },
    top3: { hits: relevant.filter((outcome) => outcome.hit).length, queries: relevant.length },
    empty: { hits: relevant.filter((outcome) => outcome.total === 0).length, queries: relevant.length },
    irrelevant: { hits: noAnswer.filter((outcome) => outcome.total > 0).length, queries: noAnswer.length },
    exactFirst: { hits: relevant.filter((outcome) => outcome.group === "exact" && outcome.expected.includes(outcome.top3[0])).length,
      queries: relevant.filter((outcome) => outcome.group === "exact").length },
    p95Milliseconds: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3)),
    outcomes,
  };
}

const results = [];
const capabilityRanking = [];
const suggestionQueries = [
  { q: "warehouse stock reserve yearly", expected: "hold-inventory", missingTerm: "yearly" },
  { q: "tax receipt email verified", expected: "send-receipt", missingTerm: "verified" },
  { q: "배포 audit 로그 보관", expected: "log-tool", missingTerm: "보관" },
  { q: "pdf table extract spreadsheet", expected: "table-converter", missingTerm: "spreadsheet" },
  { q: "warehouse invoice postcard", expected: null },
  { q: "maritime whale census", expected: null },
];
const suggestedSearches = [];
const capabilityQueries = capabilityCases.map(({ q, id }) => ({ group: "single-capability", q, ids: [id] }));
for (const size of [100, 1000]) {
  const store = new TargetStore(":memory:");
  try {
    populate(store, size);
    results.push({ size, literal: measure(store, {}), normalized: measure(store, { match: "normalized" }) });
    capabilityRanking.push({ size, literal: measure(store, {}, capabilityQueries),
      normalized: measure(store, { match: "normalized" }, capabilityQueries) });
    suggestedSearches.push({ size, outcomes: suggestionQueries.map(({ q, expected, missingTerm }) => {
      const options = { q, limit: 3, offset: 0, includeDisabled: false, view: "summary", match: "normalized" };
      const strict = store.search(options);
      const comparison = store.search({ ...options, suggest: true });
      const suggestions = comparison.suggestions.map(({ id, missingTerm }) => ({ id, missingTerm }));
      const first = suggestions[0];
      return { q, expected, ...(missingTerm ? { missingTerm } : {}), strictTotal: strict.total, suggestionSearchTotal: comparison.total, suggestions,
        hit: expected === null ? suggestions.length === 0 : first?.id === expected && first.missingTerm === missingTerm };
    }) });
  } finally {
    store.close();
  }
}

/** Compare the JSON payloads for one candidate page and a subsequent full target lookup. */
function measurePayload(targets, q, filters = {}) {
  const store = new TargetStore(":memory:");
  try {
    for (const target of targets) {
      store.create(target);
    }
    const options = { q, includeDisabled: false, limit: 20, offset: 0, ...filters };
    const full = store.search(options);
    const summary = store.search({ ...options, view: "summary" });
    const total = full.items.length;
    if (!total || summary.view !== "summary"
      || JSON.stringify(full.items.map(({ id }) => id)) !== JSON.stringify(summary.items.map(({ id }) => id))) {
      throw new Error("Summary and full pages must contain the same ranked target IDs.");
    }
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
    const lookupBytes = Buffer.byteLength(JSON.stringify(store.get(summary.items[0].id)));
    return { q, filters, targets: total, ids: summary.items.map(({ id }) => id), fullBytes, summaryBytes, lookupBytes,
      summaryAndLookupBytes: summaryBytes + lookupBytes };
  } finally {
    store.close();
  }
}

const { targets: publicTargets } = JSON.parse(await readFile(new URL("../examples/public-docs-registry.json", import.meta.url), "utf8"));
const schemaCatalog = Array.from({ length: 20 }, (_, index) => ({
  id: `integration-${index}`, name: `Usage integration ${index}`, protocol: "mcp", enabled: true, tags: ["usage"],
  description: "Read usage data and reports from an integration. ".repeat(8).trim(),
  connection: { transport: "streamable-http", url: "https://fixture.example/mcp" },
  capabilities: Array.from({ length: 30 }, (_, capability) => ({
    name: `read_usage_report_${capability}`, description: "Read an aggregate usage report for a time interval. ".repeat(5).trim(),
    inputSchema: { type: "object", required: ["interval"], properties: {
      interval: { type: "string", description: "The reporting window in ISO 8601 format." },
      category: { type: "string", enum: ["compute", "memory", "storage", "network"], description: "Filter the returned usage by category." },
    } },
  })),
}));
const payloads = {
  publicSnapshot: measurePayload(publicTargets, "documentation"),
  publicSnapshotFiltered: measurePayload(publicTargets, "documentation", { transport: "streamable-http", auth: "none" }),
  schemaCatalog: measurePayload(schemaCatalog, "usage"),
};
process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  results, capabilityRanking, suggestedSearches, payloads }, null, 2) + "\n");
