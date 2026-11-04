# Select an explicit group of targets

This feature is unreleased and requires a source checkout containing repeated `--select ID` selection for diagnosis and metadata refresh. Published `0.1.3` does not include it.

Use an explicit group to inspect or refresh only the registrations you name, including a subset that failed in a previous batch:

```sh
npm run build
node dist/index.js doctor --select docs --select researcher
node dist/index.js target refresh --select docs --select researcher
node dist/index.js target refresh --select docs --select researcher --apply
```

Replace the example IDs with registered IDs. MCP and A2A targets can be selected together. This selects registrations for diagnostics or metadata refresh; it does not execute tools or agent tasks.

## Selectors and limits

Repeat `--select` once per ID. IDs must be valid, nonempty, and unique. Input order determines report order even when inspections complete out of order. The selection cap defaults to 100, maximum 1000; `--limit` can change it within that range. Provider-work concurrency defaults to 3 and accepts 1 through 8.

Explicit IDs are an alternative to `--all` with discovery filters. Do not combine `--select` with `--all`, `--q`, `--protocol`, or `--tag`. Do not combine it with `doctor --target` or a positional refresh ID. Use `--all` for keyword/tag/protocol discovery; use explicit IDs when the exact group is known.

The shared selector resolves IDs through read-only per-target lookups and does not enumerate catalog pages. The requested count is checked against `--limit` before any of those lookups. Ordinary doctor hub health/authenticated-discovery checks still run before its batch, as usual.

## Complete-group validation

Every selected registration must exist, be readable, and match its requested ID before any provider metadata requests or registry writes begin. An unavailable or mismatched response rejects the group with `SELECTION_TARGET_UNAVAILABLE`, empty target outcomes, and `complete: false`. Error bodies and registration values are omitted from selection diagnostics.

A registration already disabled during selection rejects the group with `SELECTION_TARGET_DISABLED` unless `--include-disabled` is supplied. This differs from discovery mode, which simply excludes disabled registrations by default. To explicitly inspect or refresh disabled entries:

```sh
node dist/index.js doctor --select archived-docs --include-disabled
node dist/index.js target refresh --select archived-docs --include-disabled --apply
```

Refreshing an included disabled registration preserves its disabled state. Missing/unreadable selections do not silently shrink to the readable subset. Duplicate/invalid IDs and mixed selector modes fail before hub/provider work; exceeding the cap stops before per-ID lookups.

Selection lookups are sequential and use existing hub timeouts. They form an observation, not an atomic snapshot. Workers reread current definitions after selection. A target removed later receives an individual failure while other targets continue. Refresh also checks for concurrent disables and connection changes before conditional writes, as described in [batch refresh](batch-refresh.md). Diagnosis remains read-only.

## Reports and application

Reports use the existing batch shapes. `selection.select` records the requested IDs. In explicit mode, `matched` means the number of requested unique IDs, including when preflight fails; it does not certify that every ID was found. `complete: false` means provider work did not begin for a rejected selection. After successful selection, `complete: true` means every selected ID received a terminal outcome, including any later skips/failures.

Refresh still defaults to a preview. A separate explicit `--apply` uses a fresh selection and remote inspection, applies changed targets independently with version conditions, and preserves unchanged definitions. It is not bound to a prior preview and does not roll back successful updates when another target fails. No automatic retry is added.

Credential behavior is unchanged: doctor and refresh previews use the usual read credential selection; refresh application requires an administrator credential. Provider credentials remain target-specific. `--bearer-env` and A2A binding/version overrides remain single-target refresh options.

Terminal output is readable; redirected output and `--json` produce JSON. Invalid options, selection failures, and failed target work exit 1. Existing warning/skipped semantics remain unchanged. `executionVerified` remains false.

Existing single-target diagnosis and refresh retain their behavior. `doctor --target ID` diagnoses one registration; positional `target refresh ID` applies immediately unless `--dry-run` is supplied. Existing import/preset `--select` options keep their own source-name/ID meanings.
