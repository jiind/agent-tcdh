import type { DiscoverySearchResult } from "../targets/schema.js";

/** Remove terminal controls before displaying user-provided metadata in a compact table. */
function cell(value: unknown, width = 32): string {
  const text = String(value).replace(/[\p{Cc}\p{Cf}]/gu, " ");
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}

/** Format terminal target lists while leaving JSON output untouched for automation. */
export function targetTable(result: DiscoverySearchResult): string {
  if (result.total === 0) {
    const suggestions = result.suggestions ?? [];
    return "0 matching targets.\n" + (suggestions.length ? "\nSuggestions missing one search term\n"
      + suggestions.map(({ id, name, missingTerm }) => `${id}  ${cell(name)}  Missing ${JSON.stringify(cell(missingTerm, 48))}`).join("\n") + "\n" : "")
      + (result.exclusions && Object.values(result.exclusions).some(Boolean) ? "\nKeyword matches excluded by filters\n"
        + Object.entries(result.exclusions).filter(([, count]) => count > 0).map(([filter, count]) => cell(filter) + "  " + count).join("\n") + "\n" : "");
  }
  const values = "view" in result
    ? [["ID", "PROTOCOL", "TRANSPORT", "AUTH", "ENABLED", "CAPABILITIES", "MATCHED CAPABILITIES"], ...result.items.map((target) => [
      target.id, target.protocol, target.transport, target.authType ?? "-", String(target.enabled), String(target.capabilityCount),
      target.matchedCapabilities.map(({ name }) => name).join(", "),
    ])]
    : [["ID", "PROTOCOL", "TRANSPORT", "ENABLED", "CAPABILITIES"], ...result.items.map((target) => [
      target.id, target.protocol, target.connection.transport, String(target.enabled), String(target.capabilities.length),
    ])];
  const rows = values.map((row) => row.map((value) => cell(value)));
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd()).join("\n")
    + "\n" + result.items.length + " shown; " + result.total + " matches; offset " + result.offset + ".\n"
    + (result.freshness ?? []).map((item) => item.id + "  " + item.state + " / " + item.status
      + (item.checkedAt ? "  " + item.checkedAt : "") + "\n").join("")
    + (result.explanations ?? []).map(({ id, terms }) => id + "  "
      + terms.map(({ term, fields }) => JSON.stringify(cell(term, 48)) + " in " + fields.map((field) => cell(field, 80)).join(", ")).join(" | ") + "\n").join("")
    + ("view" in result ? result.items.flatMap((target) => target.matchedCapabilities.filter((item) => item.requiredInputs !== undefined)
      .map((item) => target.id + " / " + cell(item.name) + "  Required inputs: "
        + (item.requiredInputs === null ? "see the full schema" : item.requiredInputs!.map(({ name, type }) => cell(name) + (type ? " (" + type + ")" : "")).join(", ") || "none")
        + (item.requiredInputCount && item.requiredInputs && item.requiredInputCount > item.requiredInputs.length ? " (" + item.requiredInputCount + " total)" : "") + "\n")).join("") : "")
    + (result.nextCursor ? "Next page: --cursor " + result.nextCursor + "\n" : "");
}

/** Print human-oriented text only in a terminal, or stable JSON when requested or redirected. */
export function printOnboarding(value: unknown, json: boolean | undefined, text: () => string): void {
  process.stdout.write(!json && process.stdout.isTTY ? text() + "\n" : JSON.stringify(value, null, 2) + "\n");
}

export function formatConnectionPlan(plan: { action: string; path: string; differingFields: string[]; requiresReplace: boolean; normalizesFile: boolean }): string {
  return "Connection plan: " + plan.action + " " + JSON.stringify(plan.path)
    + (plan.differingFields.length ? "\nDiffering fields: " + plan.differingFields.join(", ") : "")
    + (plan.requiresReplace ? "\nApplying this plan requires --replace." : "")
    + (plan.normalizesFile ? "\nApplying this plan normalizes TOML formatting and preserves a backup." : "");
}

/** Render copied setup commands for POSIX shells or Windows PowerShell without evaluating arguments. */
export function formatCommand(args: string[], platform = process.platform): string {
  const words = args.map((value) => /^[a-zA-Z0-9_./:-]+$/u.test(value) ? value
    : "'" + value.replaceAll("'", platform === "win32" ? "''" : "'\\''") + "'");
  return (platform === "win32" ? "& " : "") + words.join(" ");
}
