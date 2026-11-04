# Refresh metadata for multiple registrations

Batch refresh requires AgentTCDH `0.1.4` or later. Version `0.1.3` does not include this mode. Existing single-target refresh retains its original behavior: it applies immediately unless `--dry-run` is supplied.

```sh
npm run build
node dist/index.js target refresh --all --tag team-docs
node dist/index.js target refresh --all --tag team-docs --apply
node dist/index.js target refresh --all --protocol a2a --limit 200 --concurrency 3 --json
```

Select matching registrations with `--all` or an explicit group with repeated `--select ID` options. See [explicit target selection](target-selection.md) for whole-group checks and request ordering.

Batch mode defaults to a preview. `--dry-run` explicitly requests that same behavior; do not combine it with `--apply`. Do not provide a positional ID with either batch selector or combine `--all` and `--select`. Without either batch selector, existing single-target arguments and output remain unchanged.

## Selection and remote inspection

Keyword, protocol, tag, and disabled-state filters have the same meaning as discovery. Disabled targets are excluded by default; `--include-disabled` permits inspecting and updating them while preserving their disabled state. The default selection limit is 100, maximum 1000. Concurrency defaults to 3 and accepts integers from 1 to 8.

With `--all`, the CLI collects all read-only discovery pages before probing providers or writing anything. With `--select`, it resolves the requested IDs directly and validates the complete group before provider work. Exceeding `--limit`, duplicate/incomplete pages, mismatched pagination, or an observed total change stops selection without per-target work. The shared collector also serves `doctor --all`.

Discovery is a paginated observation, not a transactional snapshot. Same-count membership changes can escape page checks. Discovery-selected IDs retain discovery order; explicitly selected IDs retain input order. In both modes, their current definitions are reread before inspection. Changes to keyword/tag/protocol membership after selection do not trigger a new search. A target disabled before either refresh reread is skipped unless `--include-disabled` is set.

The command runs in the CLI environment. It initializes remote HTTP/SSE MCP servers and lists tools, or retrieves an A2A Agent Card using the target's existing metadata location, binding, and version. Existing metadata response, pagination, and timeout bounds still apply. It does not execute tools/tasks or launch registered stdio commands. Metadata inspection is an outbound connection even in preview mode; it is not an offline operation.

## Credentials and skipped targets

Hub preview requests use the usual read-credential selection; applying requires an administrator credential. A read-only setup cannot silently use a provider credential for administration. Use `--token-env` to explicitly select the hub credential if needed.

Provider authentication comes from each registration's own single Bearer environment reference, resolved in the CLI environment. Hub authentication is not used as a fallback for provider authentication. Stdio targets, unsupported OAuth/API-key authentication, and ambiguous or absent Bearer references are reported as skipped. A missing/invalid value for a selected Bearer variable causes that target to fail without printing its value. Use single-target commands to diagnose or select an explicit provider reference; batch mode rejects `--bearer-env` and A2A binding/version overrides so one credential/selection is not applied indiscriminately to different providers.

## Updates and concurrency

A preview returns field names and capability counts rather than full definitions, URLs, command arguments, provider descriptions, or raw error bodies. The fields that can change are `capabilities` and, for A2A, `connection`. Name, description, tags, enabled state, authentication references, and other managed connection fields are preserved using the existing refresh merger.

Each target is reread after inspection. A connection/protocol change during inspection fails that target; concurrent label changes are retained. Changed proposals are saved with `If-Match` against that final observed version. A later concurrent write produces a conflict; there is no automatic retry. Unchanged proposals cause no registry write, preserving their version and timestamps. Object key order does not count as a change; array order remains significant.

Application rereads metadata and registrations; it is not bound to an earlier preview. Writes are independent per target. A failure does not roll back already updated targets or prevent the remaining targets from being processed. Review the summary and individual outcomes, then retry only after checking failed registrations.

## Reports and exit codes

The report includes filters/resource limits, `matched`, `complete`, `dryRun`, `applyRequested`, a summary, and ordered target outcomes. `complete: true` means every selected ID reached an outcome, including failures/skips; it does not mean every target was updated. `baseVersion` is the observed pre-write ETag, not a promise about the final registry version.

| Outcome | Meaning |
| --- | --- |
| `planned` | A preview found changed metadata |
| `updated` | An explicit application saved changed metadata |
| `unchanged` | No write was needed |
| `skipped` | The selected target/state/authentication is unsupported for this batch |
| `failed` | A lookup, inspection, merge, or conditional write failed |

Selection failures and any failed target produce status `failed` and exit 1. Skips or an empty selection produce status `warning` and exit 0 when there are no failures. Otherwise status is `passed` and exit 0. Terminal output is readable text; redirected output and `--json` use JSON. Every report sets `executionVerified: false`.

Use `doctor --all` for diagnostics, `target check ID` for detailed metadata drift, and `target refresh ID --dry-run` when a single registration needs explicit credential or A2A selection options.
