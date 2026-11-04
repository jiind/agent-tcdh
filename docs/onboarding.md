# Guided setup, connection, and diagnostics

Core setup requires AgentTCDH `0.1.2` or later; saved-profile checks, disconnection, backup discovery, and restoration require `0.1.3`. From a source checkout, run `npm ci` and `npm run build`, then replace `agent-tcdh` below with `node dist/index.js`. See the [v0.1.2 release notes](releases/v0.1.2.md) for installation and publication checks. The default suite uses temporary files and local protocol fixtures; it does not modify personal agent configuration or run models.

## Initialize once

```sh
agent-tcdh init
agent-tcdh serve
```

`init` first selects local setup or an existing remote hub, then asks for the listener, consumer-facing hub URL, database location, and optional credential environment names. It writes `~/.agent-tcdh/config.json` and prints the next commands. It does not launch a daemon. Start `serve` in a separate terminal or with your process manager.

For automation, provide `--yes`; non-interactive input without it fails immediately:

```sh
agent-tcdh init --yes --config ./local-config.json --port 3100 --db ./registry.sqlite
agent-tcdh serve --config ./local-config.json
```

To connect to an existing shared hub without running a local server:

```sh
agent-tcdh init --yes --remote --hub https://hub.example.com --read-token-env HUB_READER
agent-tcdh connect codex --print
agent-tcdh doctor
```

Remote setup prints client/discovery next steps and does not suggest starting `serve`. A remote setup can record only a read credential; administrative mutations then require an explicit administrator credential. Remote setup requires a hub URL and rejects local listener/database options. Use a separate local configuration to operate a server.

The default database remains `~/.agent-tcdh/registry.sqlite`. Database paths stored by setup are absolute; relative setup paths are resolved beside the configuration file. `--config FILE` or `AGENT_TCDH_CONFIG` selects an alternate configuration. A missing default file preserves the original CLI behavior, while an explicitly selected missing/invalid file fails with instructions.

For addresses, ports, and database settings, precedence is CLI option, existing environment variable, setup configuration, then built-in default. `AGENT_TCDH_URL` overrides the saved consumer URL; `HOST`, `PORT`, and `AGENT_TCDH_DB_PATH` override saved server settings.

An existing setup file is preserved unless `init --force` is requested. Replacement writes an exact, uniquely named backup before atomically replacing the file. New setup, client configuration, and backup files use mode `0600` on POSIX. Windows uses its native filesystem permissions. Symbolic-link destinations, oversized configuration files, and detected concurrent modifications are rejected.

## Credential references

Setup records environment **names**, never their values:

```sh
agent-tcdh init --yes --token-env HUB_ADMIN --read-token-env HUB_READER
```

Set `HUB_ADMIN` and `HUB_READER` to distinct actual tokens in your server environment before `serve`. Set `HUB_READER` in the consuming agent environment before connecting. Missing explicitly configured credentials fail instead of falling back to anonymous access. `init` does not create provider accounts, obtain OAuth credentials, or generate token values.

Administrative CLI commands use `--token-env`, then the setup administrator reference, then the original optional `AGENT_TCDH_TOKEN`. Registry read commands prefer the setup read reference. Metadata-only quick-add/import previews do not require hub credentials unless explicitly selected. `connect` and `doctor` prefer the setup read reference, then `AGENT_TCDH_READ_TOKEN`, then an administrator reference if available. The `mcp` stdio bridge prefers the configured read reference; without setup it retains its original token behavior. `serve` resolves the configured administrator/read names, falling back to the original `AGENT_TCDH_TOKEN` / `AGENT_TCDH_READ_TOKEN` names when unspecified.

Local setup without credentials uses the loopback listener by default. Configure authentication and the advertised URL before sharing the listener.

## Add targets without a definition file

For remote targets, replace the example URL with your own endpoint:

```sh
agent-tcdh target add https://mcp.example.com/mcp --dry-run
agent-tcdh target add https://mcp.example.com/mcp
agent-tcdh target add https://agent.example.com --protocol a2a --id researcher
```

Without `--protocol`, quick add probes MCP metadata and an A2A Agent Card. It uses the selected card URL, with a same-origin `/.well-known/agent-card.json` fallback. The probes are bounded by an overall 15-second budget, fetch metadata only, and inherit the existing redirect, credential-origin, size, and capability limits. When both protocols are available, registration stops and requests an explicit selection. It does not guess an execution protocol or silently overwrite an existing target.

Ids are derived deterministically from connection details; `--id` overrides them. Display names, descriptions, tags, Bearer environment references, A2A bindings, and versions can be specified with the existing options. Use an explicit protocol for binding/transport selectors:

```sh
agent-tcdh target add https://mcp.example.com/sse --protocol mcp --transport sse --id legacy
agent-tcdh target add https://agent.example.com/custom-card --protocol a2a --a2a-binding JSONRPC
agent-tcdh target add https://mcp.example.com/mcp --protocol mcp --bearer-env PROVIDER_TOKEN
```

For local stdio MCP servers:

```sh
agent-tcdh target add --command npx --arg=-y --arg=@example/mcp-server --name "Local docs" --env-var PROVIDER_TOKEN --dry-run
```

Each `--arg` is a literal argument, not shell text. Use `--arg=--some-flag` for values starting with `-`. Stdio registration stores the executable, arguments, and environment names without launching the command or claiming observed capabilities. Required provider values belong in the consumer environment.

The original `target add definition.json` and explicit `target import URL --id ID --protocol ...` commands remain available.

## Configure an agent

Preview only the new hub fragment:

```sh
agent-tcdh connect codex --print
agent-tcdh connect opencode --print
agent-tcdh connect opencode-v1 --print
```

- `codex`: TOML `mcp_servers.agent_tcdh`, Streamable HTTP URL, optional `bearer_token_env_var`.
- `opencode`: OpenCode v2 JSON/JSONC `mcp.servers.agent_tcdh`.
- `opencode-v1`: OpenCode v1 JSON/JSONC `mcp.agent_tcdh`.

OpenCode templates set `oauth: false` because hub authentication uses optional Bearer references. An explicitly selected token environment need not exist in the setup terminal; it must exist where the client runs. Templates contain the environment placeholder, not the token value. The client version is selected explicitly; templates do not detect or launch installed agent binaries.

To preview a merge into an existing file and then apply it:

```sh
agent-tcdh connect codex --write ./client-config.toml --dry-run
agent-tcdh connect codex --write ./client-config.toml
agent-tcdh connect opencode --write ./opencode.jsonc
```

No personal configuration path is chosen or written automatically. `--write FILE` is the explicit destination. Existing entries for other servers and other configuration fields are preserved, and replacements produce a backup. An identical hub entry is a no-op. A conflicting entry requires `--replace`; `--name` selects a different connection name. An OpenCode layout/version mismatch is rejected rather than reinterpreted.

JSONC edits preserve surrounding comments. Codex appends and managed-block updates preserve existing text where possible. Inline or unmanaged TOML layouts may require normalization with `--replace`; normalization can change formatting/comments, so the exact original is retained in the backup. Invalid syntax is rejected with a fixed diagnostic that does not echo existing secrets. Write results omit the full existing configuration; dry-run output shows only the new fragment and planned path.

Version `0.1.3` adds `connect --check FILE` for read-only comparison of saved profiles. See [saved connection checks](connection-check.md); version `0.1.2` does not include this option.

Version `0.1.3` also supports `disconnect CLIENT --file FILE` to preview removing a selected entry, with `--apply` for an actual edit and exact backup. See [client disconnection](client-disconnection.md) for TOML handling and named-entry selection.

Version `0.1.3` provides `config backups --file FILE` to find matching sibling backup metadata and restore preview commands. See [backup discovery](configuration-backups.md).

To recover the entire file from a returned backup, version `0.1.3` provides `config restore BACKUP_FILE --file FILE` with a preview by default and explicit `--apply`. See [configuration restoration](configuration-restore.md).

Reload the agent after applying settings. The normal `connect` result also includes a ready-to-use instruction: search capabilities with `search_targets`, retrieve current details with `get_target`, and connect directly using the client environment's protocol support, credentials, and permissions. Configuring hub discovery does not dynamically mount every registered target into the client's native tool catalog.

Configuration formats were checked against [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp), [OpenCode v2 MCP documentation](https://opencode.ai/v2/docs/mcp-servers/), and [OpenCode v1 documentation](https://opencode.ai/docs/en/mcp-servers/) on 2026-10-29. Templates and merging are tested with local fixtures; these checks do not claim new model-driven agent executions.

Additional `claude-code`, `gemini-cli`, `cursor`, and `vscode` profiles generate local stdio discovery connections. See [more MCP client connections](client-connections.md) for explicit file destinations, environment references, machine-specific paths, and the SDK verification scope.

## Diagnose problems

```sh
agent-tcdh doctor
agent-tcdh doctor --target researcher --json
```

`doctor` checks Node.js, selected hub credential availability, public hub health, and authenticated discovery separately. Health success alone is not a successful authenticated connection. Failures include a suggested next action.

With `--target`, it reads that registration and checks environment references. For stdio targets it checks executable presence/access without spawning anything; metadata and execution remain unchecked. For remote targets it reuses `target check` to inspect MCP tool metadata or the A2A card and report drift. It does not refresh registrations, execute tools/tasks, or probe every registered endpoint automatically.

`passed`, `warning`, `failed`, and `skipped` describe the reported check scope. `executionVerified` remains `false`. A failed check exits with code 1; warnings and skipped checks do not alone cause a failure. Credential values and raw remote error bodies are excluded from diagnostics.

### Inspect multiple registrations

```sh
agent-tcdh doctor --all
agent-tcdh doctor --all --tag imported-config --protocol mcp --concurrency 3
agent-tcdh doctor --all --q docs --include-disabled --limit 200 --json
```

`--all` explicitly opts into inspecting every registration matching the selected filters. Without it, ordinary `doctor` still checks only the hub; `--target ID` still inspects one target. Discovery filters require `--all`; `--target` and `--all` cannot be combined. Source checkouts additionally support repeated `--select ID` as an alternative batch selector, with batch limits/concurrency and `--include-disabled`; see [explicit target selection](target-selection.md). Keyword, protocol, and tag filters have the same meaning as `target list`. Disabled registrations are excluded unless `--include-disabled` is supplied.

The batch first collects matching IDs through the read-only paginated discovery API. `--limit` is a safety cap, default 100, allowed range 1–1000. If the match count exceeds that cap, selection fails before any provider metadata requests or local executable checks. It does not silently truncate the list. Narrow the filters or explicitly increase the cap. Detected changes in page totals, duplicate IDs, incomplete pages, and discovery errors also stop selection before target inspection.

The discovery list is not a transactional snapshot: a same-count concurrent edit may escape page consistency checks. Each selected target is reread with its current ETag immediately before inspection, and each report includes `targetVersion`. Membership follows the collected IDs; a later edit can change a target's filter fields or connection. A removed/unreadable target gets an individual failure, and the remaining targets are still checked. Registry definitions and versions are never changed by diagnostics.

`--concurrency` bounds simultaneous target inspections, default 3, allowed range 1–8. Results retain discovery order even when requests complete in a different order. Each remote metadata inspection retains the existing 10-second timeout and import limits; hub API reads have separate 15-second timeouts. Large batches can take multiple waves of requests.

JSON adds a `batch` object with the selection, `matched` count, `complete`, per-target reports, and `summary` counts for `passed`, `warning`, and `failed`. `complete: true` means all selected targets received a result, including individual failures. A selection failure leaves `complete: false`, no target results, and a fixed `selectionIssue`. A failed initial hub discovery skips the batch and reports the reason in the top-level checks. An empty matching set is a warning.

The summary combines consumer environment/executable prerequisites with metadata findings. A target can pass its applicable checks while metadata is skipped, such as stdio or unsupported OAuth inspection. Examine each target's `metadata.status`, `scope`, and `issues` for that distinction; `passed` does not establish tool/task execution. Stdio commands are never launched. Remote checks only list MCP tools or retrieve A2A cards. Hub credentials are used for hub access; target credential references are resolved independently from this terminal's environment. Run diagnostics in an environment that represents the consuming agent.

Exit code 1 indicates a failed hub check, selection, or target; warnings, empty selections, and skipped metadata alone exit 0. Terminal output shows individual checks and suggested next actions. `executionVerified` remains false throughout.

## Manage registrations

Use `target edit` for labels/tags, `target enable`/`disable` for discovery state, and `target remove --dry-run` to review one deletion. [Target management](target-management.md) describes previews, no-ops, credentials, and automatic version guards.

## Terminal and automation output

New setup/connection/diagnostic commands show readable summaries in a terminal. `target list` shows a compact table in a terminal. Piped output remains JSON, and `--json` explicitly requests JSON. Existing registration/get/update/remove and snapshot JSON shapes remain unchanged.

`connect --print` is the deliberate exception: it emits only a TOML/JSON configuration fragment, including when piped. Do not combine it with `--write` or `--json`. `--dry-run` for connection requires an explicit `--write FILE` to preview.

## Refresh matching remote registrations

Source checkouts support unreleased `target refresh --all` previews and explicit `--apply` to save changed metadata. It uses the same bounded discovery selection as `doctor --all`, preserves managed labels/state, and reports per-target skips/failures. See [batch metadata refresh](batch-refresh.md); published `0.1.3` does not include this mode.
