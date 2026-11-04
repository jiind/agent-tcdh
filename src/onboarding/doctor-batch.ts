import { z } from "zod";
import type { HubClient } from "../client.js";
import { batchTargetOptionsSchema, selectBatchTargets } from "../targets/batch.js";
import { diagnoseTarget } from "./doctor.js";

export const batchDiagnosisOptionsSchema = batchTargetOptionsSchema;
export type BatchDiagnosisOptions = z.infer<typeof batchDiagnosisOptionsSchema>;
type TargetDiagnosis = Awaited<ReturnType<typeof diagnoseTarget>>;
type BatchTarget = Omit<TargetDiagnosis, "metadata"> & { metadata?: TargetDiagnosis["metadata"]; targetVersion?: string };
export interface BatchDiagnosisReport {
  status: "passed" | "warning" | "failed";
  selection: BatchDiagnosisOptions;
  matched: number;
  complete: boolean;
  summary: { passed: number; warning: number; failed: number };
  targets: BatchTarget[];
  executionVerified: false;
  selectionIssue?: { code: string; message: string };
}

/** Select explicit or matching registrations before probing, then inspect them with bounded concurrency. */
export async function diagnoseBatch(client: HubClient, input: BatchDiagnosisOptions, environment = process.env): Promise<BatchDiagnosisReport> {
  // 1. Validate resource limits and resolve a bounded group through read-only registry requests.
  const options = batchDiagnosisOptionsSchema.parse(input);
  const report: BatchDiagnosisReport = { status: "passed", selection: options, matched: 0, complete: false,
    summary: { passed: 0, warning: 0, failed: 0 }, targets: [], executionVerified: false };
  const selected = await selectBatchTargets(client, options);
  report.matched = selected.matched;
  if (selected.issue) {
    report.status = "failed";
    report.selectionIssue = selected.issue;
    return report;
  }
  const definitions = selected.targets;

  // 2. Reread each target and its version before inspecting metadata; isolate individual failures.
  let next = 0;
  const targets: BatchTarget[] = new Array(definitions.length);
  /** Consume independent targets while retaining discovery order in the final report. */
  async function worker() {
    while (next < definitions.length) {
      const index = next++;
      const selected = definitions[index]!;
      try {
        const current = await client.getVersioned(selected.id);
        targets[index] = { ...await diagnoseTarget(current.target, environment), targetVersion: current.etag };
      } catch {
        targets[index] = { id: selected.id, protocol: selected.protocol, transport: selected.connection.transport,
          status: "failed", checks: [{ id: "target", status: "failed", message: "The selected target could not be inspected.",
            action: "Check whether the registration changed or was removed, then retry discovery." }], executionVerified: false };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, definitions.length) }, () => worker()));

  // 3. Summarize prerequisites and metadata outcomes without writing registry state or claiming execution.
  report.targets = targets;
  report.complete = true;
  for (const target of targets) {
    report.summary[target.status]++;
  }
  report.status = report.summary.failed > 0 ? "failed" : report.summary.warning > 0 || targets.length === 0 ? "warning" : "passed";
  return report;
}
