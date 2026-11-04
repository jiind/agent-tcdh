# Manage existing connections as a reusable workflow

Requires AgentTCDH `0.1.5` or later. This bundle extends [local client import](local-import.md) with interactive selection, private profiles, source synchronization, optional metadata follow-up, registry duplicate cleanup, and explicitly authorized stdio inspection. See [release notes](releases/v0.1.5.md) for artifact availability. From a source checkout, build first and replace `agent-tcdh` in examples with `node dist/index.js`.

## Select connections interactively

```sh
agent-tcdh registry import-local --interactive
agent-tcdh registry import-local --interactive --save-profile work --apply
```

Use arrow keys to move, space to toggle, `a` to toggle all, Enter to accept a nonempty selection, and Escape/Ctrl+C to cancel. No entry is preselected. The list shows source-qualified keys, protocol, and preparation status; source validation still determines whether the final group can be imported. Initial discovery does not fetch remote cards, even if `--fetch-a2a-cards` was supplied; only the chosen group is subsequently inspected. Terminal state is restored on completion/cancellation. Interactive mode requires a terminal and cannot be combined with `--select` or `--profile`.

## Save private import profiles

```sh
agent-tcdh registry import-local --client codex --client cursor --project /path/to/project --save-profile work
agent-tcdh import-profile list
agent-tcdh import-profile show work
agent-tcdh registry import-local --profile work --apply
```

`--save-profile` explicitly writes a ready selection even when registration is only previewed. Profiles live in `~/.agent-tcdh/import-profiles.json`, or the explicit `--profiles-file FILE`. The versioned private store uses atomic writes, exact backups, and a cooperating operation lock. It permits at most 50 profiles, 1 MiB total storage, and 1,000 managed registrations per profile, subject to the storage limit. Capacity is checked before registration changes.

A profile records the hub URL, optional credential environment names, absolute project and source locations, scope, optional prefix/selections, and per-field synchronization fingerprints. It does not copy source command strings or credential values into the ledger. Source location overrides are resolved when saved, so later environment path changes do not silently select another client installation. Profiles are local to this machine; portable registry snapshots remain separate.

If explicit keys or interactive selection were used, the profile tracks that fixed selection. Otherwise it continues discovering declarations at its recorded locations, including new entries. A saved profile fixes its source selectors and hub; do not combine `--profile` with `--client`, `--scope`, `--project`, `--home`, `--select`, or `--prefix`. An explicit `--hub` must match its recorded hub. Saved credential names are reused without consulting unrelated default hub setup; `--token-env` is an explicit per-invocation override. A read-only profile needs an explicit administrator reference for mutations. Provider fetch/start permissions are not saved: repeat those flags on each invocation when wanted.

Initial managed imports use conflict policy `error`; they never silently adopt an existing registry ID. Once a profile manages registrations, use `sync-local` for subsequent application. An existing profile name cannot be overwritten implicitly. Removal is previewed:

```sh
agent-tcdh import-profile remove work
agent-tcdh import-profile remove work --apply
```

Removing a profile keeps registry registrations. Interrupted operations may leave an operation lock; confirm no writer is active before removing a stale lock. Automatic lock stealing is not performed.

## Preview and synchronize source changes

```sh
agent-tcdh registry sync-local --profile work
agent-tcdh registry sync-local --profile work --apply
agent-tcdh registry sync-local --profile work --prune
agent-tcdh registry sync-local --profile work --prune --apply
```

Preview compares incoming source fields, the last acknowledged source/destination fingerprints, and current hub definitions. It reports additions, updates, unchanged/retained items, removals, forgotten already-removed orphans, and conflicts. The complete plan must be conflict-free before any writes begin. Unreadable tracked sources block pruning; missing selected declarations are considered potential removals rather than invalid selection syntax.

Hub-only changes are preserved. If the source later changes the same field to a different value, the conflict remains visible; observing a hub-only edit does not silently adopt it as source-owned state. Fields changed only at the source can update independently. A source connection change clears stale MCP capabilities, but separately modified destination metadata blocks that automatic reset. Optional follow-up metadata changes are recorded explicitly. Manually deleted managed targets are not silently recreated.

Removed source entries stay registered by default. `--prune` includes them in the plan; actual removal additionally requires `--apply`. A removed source whose remaining hub definition was independently modified is blocked from pruning. Coalesced origins retain the existing managed ID when another equivalent source becomes its representative. Splits may create additional registrations; merged/redundant historical registrations remain visible as retained candidates until explicitly pruned or cleaned up.

New sync registrations use one conflict-checked atomic import request. Existing updates/deletions use independent ETag conditions; a later conflict fails that item without retrying or rolling back successful items. Successful new ownership is checkpointed before subsequent operations. Metadata follow-up begins only after acknowledged ownership is saved. A private-ledger write failure can follow successful hub writes; its error explicitly requires inspecting/reconciling state before retrying. There is no distributed transaction between the hub and local filesystem, nor automatic recovery/adoption after an unacknowledged request or forced termination.

Apply makes a fresh source/registry observation, not a commitment to a previous preview. No background watcher is installed. Sync does not overwrite client source files or execute agent tasks.

## Continue with metadata refresh and diagnosis

```sh
agent-tcdh registry import-local --interactive --save-profile work --apply --refresh --diagnose
agent-tcdh registry sync-local --profile work --apply --refresh --diagnose
```

These explicit follow-up flags require `--apply`. Each target is inspected once for both requested phases. `--refresh` conditionally stores changed capabilities and A2A interface metadata, preserving managed labels/state/auth references; no-op metadata preserves registry revisions. `--diagnose` compares the observation with registered metadata, or with the just-refreshed definition. This is metadata diagnosis, not proof of tool/task execution or client loading. Provider credentials come only from each registration's own references, never from the hub token.

Disabled targets and unsupported authentication/transports are reported as skipped. Failed inspections do not undo successful registration; `applied: true` can coexist with failed follow-up and exit 1. Review individual outcomes before retrying. Follow-up supports at most 1,000 unique prepared IDs and processes them sequentially within existing per-target metadata bounds.

## Inspect stdio only with explicit authorization

```sh
agent-tcdh registry import-local --interactive --apply --refresh --diagnose --inspect-stdio
agent-tcdh registry sync-local --profile work --apply --refresh --inspect-stdio
agent-tcdh target inspect-stdio TARGET_ID
agent-tcdh target inspect-stdio TARGET_ID --apply --stdio-cwd /path/to/project
```

The dedicated command authorizes process startup itself; the import/sync flow requires `--inspect-stdio` plus `--refresh` or `--diagnose`. Dedicated inspection defaults to read-only metadata diagnosis; `--apply` stores changed metadata. A drift-only diagnosis can exit 1 even when initialization succeeded; inspect the capability summary. No tool calls or A2A tasks are sent, and `executionVerified` stays false.

Starting a stdio server executes its program and may have program-defined side effects. Startup happens in the consumer CLI, never the hub. The default working directory for import/sync follow-up is the recorded project; dedicated inspection uses the CLI's working directory. `--stdio-cwd` overrides it. Literal arguments are not evaluated by a shell. Only a minimal platform environment and declared variables are passed; missing declared values prevent startup. The command can still use files/credentials accessible to that user, so this is not an operating-system sandbox.

The session bounds initialization plus `tools/list` to 10 seconds, 50 pages, 200 capabilities, 1 MiB per buffered message, 4 MiB total stdout, and 64 KiB stderr. Server stderr/raw protocol failures are not printed. Success, protocol errors, timeouts, and graceful interrupts close the owned process group or Windows process tree. Windows command shims use portable spawning. Forced host termination and processes escaping the owned tree cannot be guaranteed cleanup by a JavaScript CLI. An interrupted stdio follow-up stops subsequent inspection and retains already acknowledged ownership.

## Inspect and clean existing registry duplicates

```sh
agent-tcdh registry duplicates
agent-tcdh registry duplicates --keep preferred --remove redundant
agent-tcdh registry duplicates --keep preferred --remove redundant --apply
```

The bounded read-only scan includes disabled registrations and defaults to at most 1,000 targets. Compatible identity requires the same protocol, connection (including credential references), and enabled state. Different labels/capability metadata are shown as field differences; they are not merged. Default previews require only read access and do not contact providers.

Cleanup requires an explicit representative and 1–100 unique `--remove` IDs belonging to the same compatible group. Every selected registration is preflighted before deletion. Each removal has an ETag condition, and the representative's observed version is rechecked before each independent deletion. A changed representative or failed deletion stops further cleanup. This is an observation with conditional per-item writes, not an atomic group transaction; successful removals are not rolled back. Unselected registrations remain untouched. Cleaning up an ID tracked by an import profile will cause that profile to report the missing managed registration until explicitly reconciled.

Use `--json` for automation. Ready previews, no-ops, and successful applications exit 0; invalid/blocked plans, conflicting writes, and failed metadata diagnosis exit 1. Original explicit-file imports, single-target refresh defaults, and client configuration management retain their published behavior.
