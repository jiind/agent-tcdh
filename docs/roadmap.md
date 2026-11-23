# Environment management release bundle — v0.1.6

Bundle the following related improvements into one publication. Individual commits or PRs do not trigger a release.

- [x] Private named hub profiles with read/admin credential references and explicit activation.
- [x] Import-profile selection and source-location editing while retaining ownership.
- [x] Unified registry, source-drift, environment, and stored-metadata status.
- [x] Revision-bound freshness with explicit stale-target inspection and optional refresh.
- [x] Transactional bounded registry history and guarded single-target undo.
- [x] Guided source selection, registration, profile saving, and explicit consumer connection output.

Release gate: typecheck/regression, installed-package coverage of all six workflows, native Linux/macOS/Windows, and container verification. Publication gate: normal protected PR merge, exact-artifact verification, versioned release notes, GitHub release, and public npm installation verification. Actual results belong in the release evidence, not inferred from these implementation checkboxes.

The completed v0.1.5 import-management bundle is described in [its release notes](releases/v0.1.5.md).

The hub stays a capability/connection registry. Provider inspection runs only in an explicitly authorized consumer process; tools and A2A tasks remain direct consumer execution.

## v0.1.7 — first search and discovery quality

- Guide installed-package users from source import to their first client discovery query.
- Return a scoped `connect` command and a safe diagnostic when registration succeeds and client setup fails.
- Measure exact, overlapping, multilingual, filtered, and no-answer queries against a reproducible catalog.
- Prioritize exact IDs, names, and capabilities. Offer normalized matching for discovery while maintaining literal batch selection.
- Offer compact discovery pages that show the most relevant capabilities and let consumers fetch full metadata for the selected target.
- Prioritize targets with one capability covering every search term, with regression cases for broader targets whose capabilities only match in combination.
- Let consumers filter discovery by registered transport and remote authentication type, and show both in summary results.
- Retrieve selected target definitions in one ordered, bounded lookup across CLI, HTTP, MCP, and A2A.
- Reduce large-catalog discovery memory and measure latency and result parity on a file-backed registry.
- Help users recover from empty searches with opt-in suggestions that identify one missing term and retain connection filters.

### Discovery and management follow-through

| Order | Delivered improvement | Verification |
| --- | --- | --- |
| 1 | Search aliases for abbreviations and multilingual names | Unicode alias results and installed target edits |
| 2 | Per-term match explanations | Matching fields in the query response |
| 3 | Zero-result filter diagnostics | Independent exclusion counts for overlapping filters |
| 4 | Freshness filtering and observation details | Unknown, current, and revision-invalidated observations |
| 5 | Required-input summaries | Preview names and declared types with bounded output |
| 6 | Compact SQLite search metadata | Ranked page parity and file-backed scale benchmark |
| 7 | Registry-aware page cursors | Stable order and rejection after another connection writes |
| 8 | Interactive target selection | Bounded ordered selection followed by batch lookup |
| 9 | Private named search profiles | Installed save and reuse with explicit option overrides |
| 10 | Bash, Zsh, and PowerShell completion | Generated command and option candidates |
| 11 | Redacted connection plans | Add, unchanged, replace, and setup preflight fixtures |
| 12 | Actionable status output | Command arguments grouped by issue and credential names |
| 13 | Opt-in source-change notifications | Pinned source edits produce read-only sync previews |
| 14 | Version-specific client layouts | Authenticated first searches from Codex and OpenCode 1.x/2.x generated layouts |
| 15 | Summary and batch model verification | Fixture audit of exact IDs, filters, and query counts, with a separate opt-in Codex run |

Record before/after results in [search verification](search-verification.md) and capture package, native, and container results before versioning the bundle.
