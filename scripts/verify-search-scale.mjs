import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  baseline: { type: "string" }, database: { type: "string" }, scenario: { type: "string" }, store: { type: "string" },
} });
const currentStore = fileURLToPath(new URL("../dist/targets/store.js", import.meta.url));
const targetCount = 4_000;
const scenarios = {
  browse: { q: "", limit: 20, offset: 0, view: "summary" },
  ranked: { q: "region report", limit: 20, offset: 0, view: "summary" },
  deepPage: { q: "region_report", match: "normalized", limit: 20, offset: 1_400 },
};

/** Seed deterministic definitions with input schemas that consumers can request after discovery. */
function populate(store) {
  const inputSchema = {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`dimension_${index}`, {
      type: "string", description: "Select a documented dimension for the requested reporting interval.",
      enum: ["regional", "departmental", "monthly", "annual"],
    }])),
    additionalProperties: false,
  };
  const capabilities = Array.from({ length: 10 }, (_, index) => ({
    name: "run_report_" + index, description: "Generate usage totals for the selected region and reporting interval.", inputSchema,
  }));
  for (let index = 0; index < targetCount; index++) {
    store.create({ id: "report-" + String(index).padStart(4, "0"), protocol: "mcp", enabled: index % 10 !== 0,
      name: index % 17 === 0 ? "Region report" : "Report integration " + index,
      description: "Reporting and usage analytics.", tags: ["reports"], capabilities,
      connection: { transport: "streamable-http", url: "https://fixture.example/mcp" } });
  }
}

/** Measure one scenario in a fresh process that never holds the seeded definitions in JS. */
async function measure(database, scenario, modulePath) {
  const { TargetStore } = await import(pathToFileURL(modulePath).href);
  const store = new TargetStore(database);
  try {
    const options = { includeDisabled: false, ...scenario };
    const initialPeak = process.resourceUsage().maxRSS;
    for (let index = 0; index < 5; index++) {
      store.search(options);
    }
    const samples = [];
    let result;
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      result = store.search(options);
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const peakRss = process.resourceUsage().maxRSS;
    return { p95Milliseconds: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3)),
      peakRssMiB: Number((peakRss / 1024).toFixed(1)), peakIncreaseMiB: Number(((peakRss - initialPeak) / 1024).toFixed(1)),
      total: result.total, ids: result.items.map(({ id }) => id) };
  } finally {
    store.close();
  }
}

if (values.database) {
  process.stdout.write(JSON.stringify(await measure(values.database, scenarios[values.scenario], values.store)) + "\n");
} else {
  const directory = mkdtempSync(join(tmpdir(), "agent-tcdh-search-scale-"));
  try {
    const database = join(directory, "targets.sqlite");
    const { TargetStore } = await import(pathToFileURL(currentStore).href);
    const store = new TargetStore(database);
    try {
      populate(store);
    } finally {
      store.close();
    }
    const modules = values.baseline ? { baseline: resolve(values.baseline), current: currentStore } : { current: currentStore };
    const results = Object.fromEntries(Object.keys(scenarios).map((scenario) => {
      const runs = Object.fromEntries(Object.entries(modules).map(([label, modulePath]) => [label,
        JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--database", database,
          "--scenario", scenario, "--store", modulePath], { encoding: "utf8", timeout: 120_000 }))]));
      if (runs.baseline) {
        assert.deepEqual(runs.current.ids, runs.baseline.ids, scenario + " page IDs");
        assert.equal(runs.current.total, runs.baseline.total, scenario + " total");
      }
      return [scenario, runs];
    }));
    process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      targetCount, databaseMiB: Number((statSync(database).size / 1024 ** 2).toFixed(1)), results }, null, 2) + "\n");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}
