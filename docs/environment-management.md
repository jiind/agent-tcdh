# Manage hubs, sources, and metadata

Requires AgentTCDH 0.1.6 or later. Hub profiles and import profiles are separate: a hub profile selects a registry and credential **environment names**; an import profile tracks source files, selections, and managed registrations. Neither stores resolved token values. All examples use explicit names and destinations.

## Select a hub

```sh
agent-tcdh hub-profile save work --hub https://hub.example.com --token-env WORK_ADMIN --read-token-env WORK_READER
agent-tcdh hub-profile save work --hub https://hub.example.com --token-env WORK_ADMIN --read-token-env WORK_READER --apply
agent-tcdh hub-profile use work --apply
agent-tcdh hub-profile list
agent-tcdh target list --hub-profile work
agent-tcdh hub-profile clear --apply
```

Save/use/remove/clear preview by default. Save refuses an existing name; remove explicitly before reusing one. Removing the active profile clears the selection. `show NAME` reports its references, not their values. Storage defaults to `~/.agent-tcdh/hub-profiles.json`; `--hub-profiles-file FILE` selects isolated storage. Up to 50 profiles fit within the existing 1 MiB private-file bound. Writes are serialized, atomic, and keep exact backups. An interrupted operation can leave a lock; inspect it before removing it, rather than stealing a potentially live lock.

An explicit `--hub-profile NAME` fixes the selected registry and rejects a conflicting `--hub`, `--config`, an import profile, or `--no-config`. Otherwise a bound import profile, explicit `--config`, explicit `--hub`, or `AGENT_TCDH_URL` takes precedence over the active hub profile. Active selection affects consumer commands, never `init` or `serve`. Read commands and generated client connections use the selected read reference in preference to its administrator reference. A profile without administrator credentials cannot silently borrow the global administrator token. A profile without any references connects anonymously. `--token-env` remains an explicit override.

## Edit an import profile

```sh
agent-tcdh import-profile edit work --select cursor-project/docs
agent-tcdh import-profile edit work --select cursor-project/docs --apply
agent-tcdh import-profile edit work --all-sources --project /new/project
agent-tcdh import-profile edit work --source-path cursor-project=/new/project/.cursor/mcp.json
agent-tcdh registry sync-local --profile work
agent-tcdh registry sync-local --profile work --prune --apply
```

Repeated `--select` replaces the fixed selection; `--all-sources` follows all declarations at the recorded locations. `--project` relocates project-scoped sources relative to the previous root. User sources remain pinned; `--source-path SOURCE_ID=PATH` relocates a known source explicitly. Use `import-profile show NAME` to obtain the source IDs. Paths become absolute. Edits inspect sources offline, require a ready preview before applying, and preserve all ownership fingerprints. They do not change the registry, its hub identity, prefix, or credentials. Removed selections remain tracked until a separate sync/prune decision. Normal conflict checks apply during synchronization.

## Inspect overall status

```sh
agent-tcdh status --hub-profile work
agent-tcdh status --profiles-file /path/to/import-profiles.json --stale-hours 48 --limit 1000
```

Status checks authenticated registry access, counts enabled/disabled registrations, reads stored metadata freshness, compares import profiles belonging to this hub with their current sources, and reports whether required environment names are available in this process. It does not fetch Agent Cards, contact MCP endpoints, launch stdio servers, mutate profiles, or execute tools/tasks. Profiles belonging to another hub are skipped. Missing or unsupported sources are reported without applying changes.

The default scan cap is 1000 registrations and is configurable downwards. Freshness output is a bounded first page; use `target freshness --offset` to continue. Counts are live observations rather than an atomic registry snapshot. If discovery changes during a scan, the existing bounded selector refuses incomplete environment results. An older hub without freshness support receives a warning. Missing target variables and source issues are warnings; unavailable registry access exits 1.

## Track metadata freshness

```sh
agent-tcdh target freshness --stale-hours 24
agent-tcdh target observe --all --stale-only
agent-tcdh target observe --all --stale-only --apply
agent-tcdh target observe --select docs --apply --refresh
agent-tcdh target observe --select local-files --apply --inspect-stdio
```

`freshness` reads stored observations only. `observe` previews selection without contacting providers; `--apply` authorizes consumer-side metadata inspection and records its outcome. `--refresh` additionally saves changed metadata using conditional writes, then records the exact committed version. Repeated `--select ID` or `--all` with `--q/--protocol/--tag` uses the existing bounded selector (default 100, maximum 1000). `--stale-only` includes unknown, changed, expired, and unsuccessful observations; `--stale-hours` defaults to 24 and supports 0–8760. The freshness filtering scan supports at most 10000 registry entries.

Stdio inspection requires `--apply --inspect-stdio`; it launches registered code in the consumer process and is not an OS sandbox. Unsupported auth, disabled targets, and unauthorized stdio inspections are skipped without recording a successful check. Required provider credentials are resolved only from each target's references. MCP `tools/list` and A2A card inspection do not verify tool/task execution.

The hub assigns an observation timestamp and stores its consumer-reported status. A successful card/tool-list response with metadata drift is a warning unless `--refresh` reconciles it. A changed definition invalidates the old observation regardless of its age; deleting and recreating an ID starts as unknown. A version change during inspection prevents that outcome from being stamped as current. Observations do not advance target revisions or create change events. They are administrator-submitted reports, not independent proof by the hub. Existing `target check`, `refresh`, and import follow-up commands do not automatically create these records; use `observe` when persistence is wanted.

## Review and undo registry changes

```sh
agent-tcdh registry history --target docs --limit 20
agent-tcdh registry history show 42
agent-tcdh registry history undo 42
agent-tcdh registry history undo 42 --apply
```

History requires administrator access, including previews. Summaries show sequence, target ID, action, and timestamp. `show` explicitly includes complete before/after registry definitions. Literal arguments and URL parameters already present in a registry definition can therefore also occur in its history; protect the database and its backups accordingly. The service never resolves provider or hub credentials into history.

Every create/update/delete through HTTP or atomic import records an event in the same SQLite transaction. Failed imports and dry runs leave no events. SQLite schema 3 migrates versions 0–2 transactionally, preserving definitions/revisions. It starts history at upgrade time rather than fabricating past changes. Snapshot format 1 remains definition-only; it does not export history or metadata observations. Back up the database before upgrading; older binaries do not accept schema 3.

Retention is bounded to the newest 1000 events within a 16 MiB UTF-8 definition/overhead budget, whichever is reached first. Expired events cannot be restored. This is an operational recovery feature, not a complete audit archive. List pagination uses `nextBefore`, passed back as `--before SEQUENCE`.

Undo is limited to the latest retained event for that target and checks its exact destination revision under a database write lock. Later edits, deletion/recreation, and an occupied deleted slot prevent restoration. Undo writes a new ordinary event; it never erases or rewrites the old event. Restored deletions get a new revision and creation timestamp. Undo does not revert external tool/task effects or rewrite import-profile fingerprints; later sync can therefore report a legitimate conflict. Recover one target at a time and inspect its current state before another action.

## Complete first-use setup

```sh
agent-tcdh setup --hub-profile work
agent-tcdh setup --hub-profile work --apply --write /path/to/client-config.toml
agent-tcdh setup --yes --hub-profile work --client codex \
  --home /isolated/home --project /path/to/project --scope project \
  --select cursor-project/docs --save-profile imported-work \
  --profiles-file /path/to/import-profiles.json --write /path/to/client-config.toml --apply
```

Select a running hub with `--hub`, `--hub-profile`, or existing defaults. Interactive setup asks for the consuming client and source selection, previews connection generation and registration, and confirms explicit application. `--yes` requires an explicit consumer client and permits scripted use. Preview writes nothing, including the proposed import profile. A client configuration is written only when an explicit `--write FILE` and `--apply` are supplied. Without `--write`, the generated settings and instructions are returned for manual installation. Existing client entries require `--replace`; normal exact backups and conditional file checks apply.

Registration, private profile updates, and client-file updates span separate systems and are not one distributed transaction. If a later client write fails, the result states that registrations may already exist and directs the user to retry `connect`, rather than blindly reimporting. Setup does not start a hub, log into an agent, launch the agent, or verify execution. Source files are reread by the existing import workflow before application. Review output and permissions before starting the consuming agent.
