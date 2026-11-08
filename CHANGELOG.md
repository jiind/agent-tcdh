# Changelog

## Unreleased

No changes yet.

## 0.1.6 — 2026-11-08

- Add private named hub profiles with isolated credential references and explicit activation.
- Add previewed import-profile selection/project/source-path edits while preserving managed ownership.
- Add unified registry/source/environment status and revision-bound consumer metadata observations with stale-target selection and optional refresh.
- Add transactional bounded registry history and version-guarded undo, including deletion/recreation protection.
- Add guided consumer setup composing selection, registration, profiles, and explicit client-file output.

SQLite schema 3 migrates existing versions 0–2; snapshot format 1 and direct MCP/A2A discovery remain compatible. Back up the database before upgrading. See [v0.1.6 release notes](docs/releases/v0.1.6.md) and the [management guide](docs/environment-management.md).

## 0.1.5 — 2026-11-04

- Add bounded local client configuration discovery with source-qualified selection, duplicate origins, portable MCP adapters, and Gemini A2A card imports with explicit remote inspection.
- Add terminal checkbox selection and private reusable source profiles with pinned locations, selectors, and hub identity.
- Add tracked source synchronization with field-level conflict detection, preservation of hub-only changes, guarded optional pruning, and acknowledged ownership checkpoints.
- Add optional post-import refresh/diagnosis, registry duplicate previews and explicit conditional cleanup, and bounded consumer-side stdio metadata inspection with owned-process teardown.

The hub remains a discovery registry. SQLite schema version 2 and snapshot format version 1 are unchanged; private import-profile storage uses its own versioned format. See [v0.1.5 release notes](docs/releases/v0.1.5.md) for process authorization, synchronization scope, compatibility, and publication checks.

## 0.1.4 — 2026-11-04

- Add configuration-independent `--version`/`-v`, JSON runtime identity, and local CLI/Node/platform details in doctor reports.
- Add repeated explicit target-ID selection for batch diagnosis and refresh, preserving request order and validating the complete group before provider work.
- Add preview-first batch metadata refresh with filtered bounded selection, per-target credentials, conditional updates, no-op preservation, and independent outcomes.

Node.js 24+, SQLite schema version 2, snapshot format version 1, and HTTP/MCP/A2A contracts remain unchanged. See the [release notes](docs/releases/v0.1.4.md) for batch selection, refresh scope, and publication checks.

## 0.1.3 — 2026-10-30

- Add bounded, read-only configuration backup listings with modification-time ordering, metadata status, and installation-specific restore preview commands.
- Add offline whole-file configuration restoration with previews, exact recovery from selected backups, and backups of replaced destination files.
- Add offline `disconnect` previews and explicit named-entry removal for all seven clients, with exact backups, no-ops, and opt-in TOML normalization.
- Add read-only `connect --check FILE` across all seven client profiles, with missing/drift results, redacted field differences, and diagnostic exit codes.

Node.js 24+, SQLite schema version 2, snapshot format version 1, and HTTP/MCP/A2A contracts remain unchanged. See the [release notes](docs/releases/v0.1.3.md) for recovery scope and publication checks.

## 0.1.2 — 2026-10-30

- Add interactive/non-interactive setup with reusable local/remote defaults and credential environment references.
- Add URL-based MCP/A2A and stdio quick registration without definition files or target execution.
- Add seven client connection profiles, explicit configuration merging, backups, and isolated discovery-bridge credentials.
- Add offline-first configuration imports, selective packaged presets, and explicit atomic application.
- Add single-target and bounded batch diagnostics with metadata/execution distinctions and inspected versions.
- Add file-free label/tag editing, enable/disable commands, guarded writes, no-ops, and deletion previews.
- Add read-only registry/config/preset comparisons with field-level differences and import conflict/effect summaries.
- Preserve JSON automation output, add readable terminal summaries, and reject malformed UTF-8 snapshots without printing source values.
- Share package version metadata across MCP, A2A, import clients, and OpenAPI, with a release consistency regression check.

Node.js 24+, SQLite schema version 2, snapshot format version 1, and the discovery/direct-execution architecture remain unchanged. See the [release notes](docs/releases/v0.1.2.md) for compatibility, verification scope, and publication checks.

## 0.1.1 — 2026-10-28

- Prepare a new package version after the previous npm package was withdrawn during account migration. Previously published version numbers cannot be reused.
- Point repository metadata, documentation, release links, and trusted publisher instructions to `jiind/agent-tcdh`.
- Advertise version `0.1.1` in MCP clients/server metadata, the A2A Agent Card, and OpenAPI.
- Document GitHub tarball installation while npm publication is pending.

Runtime behavior, SQLite schema version 2, and snapshot format version 1 are unchanged. See the [release notes](docs/releases/v0.1.1.md).

## 0.1.0 — 2026-10-27

Initial public release of AgentTCDH, a shared capability and connection registry for MCP servers and A2A agents.

- Manage MCP HTTP/stdio and A2A registrations with SQLite persistence, HTTP APIs, and a CLI.
- Discover targets through MCP tools, A2A 1.0/0.3 JSONRPC, or HTTP; execute directly from the consumer.
- Search capabilities, filter and paginate results, import/refresh remote metadata, and inspect drift.
- Use separate administrator/read tokens, conditional updates, and portable JSON snapshots.
- Run an isolated local demo and installable-package checks on Linux, macOS ARM64/x64, and Windows x64.
- Include public documentation-provider examples, opt-in agent verification, and a non-root Docker deployment.

The hub returns connection metadata. Consumers supply protocol clients, credentials, selection, and execution permissions. Automatic native tool mounting, target proxying, hosted identity management, and model planning are outside this release.

See the [release notes](docs/releases/v0.1.0.md) and [verification reports](docs/platform-compatibility.md) for installation and tested scope.
