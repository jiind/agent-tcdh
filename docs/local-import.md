# Bring connections from other local AI clients

Requires AgentTCDH `0.1.5` or later; version `0.1.4` does not include local discovery/import. See [release notes](releases/v0.1.5.md) for artifact availability. From a source checkout, build with `npm ci` and `npm run build`, then replace `agent-tcdh` below with `node dist/index.js`.

Discover MCP connections already declared in other clients, plus Gemini CLI remote A2A definitions. Preview their origins and selection keys before importing:

```sh
agent-tcdh registry import-local
agent-tcdh registry import-local --client codex --client claude-code --scope project --project /path/to/project
agent-tcdh registry import-local --select codex-user/docs --select claude-code-project/search
agent-tcdh registry import-local --select codex-user/docs --select claude-code-project/search --apply
```

Default scope is `all`: user configuration plus the exact current project directory. `--scope user` and `--scope project` narrow it; project scope also includes Claude's private declarations for that exact project. `--project DIR` changes the project root. `--home DIR` selects an alternate home and suppresses environment path overrides, useful for portable installations and isolated verification. No ancestor, repository, home-directory, or network-port search is performed. Clients do not need to be installed or logged in to read their configuration files.

The default is an offline preview: no hub/provider calls, credential resolution, client command execution, or configuration writes. `--apply` imports the prepared targets through one atomic hub request and requires administrator credentials. `--compare` performs a read-only hub comparison using the normal read credential selection. `--apply`, `--compare`, and `--dry-run` follow the existing [configuration import](config-import.md) rules. `--details` requires `--compare`.

## Source locations

| Client | User source | Exact project source |
| --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `.codex/config.toml` |
| Claude Code | `~/.claude.json` top-level MCP entries | `.mcp.json` and `~/.claude.json` entries keyed by the chosen absolute project path |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json(c)`, default `~/.config/opencode/`; explicit `$OPENCODE_CONFIG` also considered | `opencode.json(c)` and `.opencode/opencode.json(c)` |
| Gemini CLI MCP | `~/.gemini/settings.json` | `.gemini/settings.json` |
| Gemini CLI A2A | `~/.gemini/agents/*.md` | `.gemini/agents/*.md` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| VS Code compatible profile | Linux: `$XDG_CONFIG_HOME/Code/User/mcp.json` (default `~/.config/`); macOS: `~/Library/Application Support/Code/User/mcp.json`; Windows: `%APPDATA%/Code/User/mcp.json` (default `~/AppData/Roaming/`) | `.vscode/mcp.json` |

OpenCode v1/v2 containers are detected independently per file. VS Code support covers the `servers` container in the listed profile locations, not every Copilot harness, profile, Insiders installation, extension, or workspace format. Other explicit files can still use `registry import-config FILE` where their format is supported. Managed policies, cloud/plugin connections, and alternate client-specific home settings are not enumerated.

These are raw declarations, not an emulation of each client's effective configuration. All found layers remain visible. Client trust, approvals, root-level filters, precedence, and runtime state are not inferred. Per-entry enabled/disabled booleans are retained where supported. Review project declarations before explicitly importing them.

## Selection, duplicates, and IDs

Each entry has a stable key such as `codex-user/docs` or `opencode-project-jsonc/files`. The server name after `/` is URL-encoded; copy the complete key shown by the preview. Repeated `--select KEY` chooses only those entries. Source order determines output order, regardless of selection argument order. Invalid or duplicate selections fail before provider work.

Target IDs include their source namespace and a stable hash of the complete selection key, so different connections named `docs` and ambiguous combinations of source/name stay distinct. `--prefix team` adds a further namespace. Preview shows the actual IDs. Across the selected group, identical protocol, connection, enabled state, and capabilities produce one target; every origin remains in `entries`, with duplicates pointing to the first origin through `duplicateOf` and the same `targetId`. Different credentials or enabled states remain distinct. Entries whose inline environment/Bearer values were omitted are never coalesced, since their original runtime settings may differ.

Selecting only a later duplicate gives it its own source-derived ID. Narrowing/changing sources can therefore change which ID represents a shared connection. Deduplication is within this import, not against existing hub entries. Use `--compare` to review destination conflicts and `--on-conflict error|skip|replace` when applying. `replace` replaces the complete matching definition, including capabilities; the default `error` rolls back the whole import on a conflict.

## MCP conversion

The existing portable MCP conversion rules apply. Gemini `httpUrl` means Streamable HTTP; Gemini `url` means SSE. Claude's `streamable-http` alias is accepted. Same-name `${NAME}` references in Claude/Gemini environment maps and `${env:NAME}` references in Cursor/VS Code maps retain the variable name. Corresponding Bearer header references also retain their name. Values are supplied by the consuming environment.

Inline environment/Bearer values are omitted with diagnostics. An omitted Bearer value receives a source-specific proposed variable name. Client-managed auth, custom headers, environment aliases, input/workspace substitutions, working directories, and unsupported execution settings require manual configuration. Literal stdio arguments are preserved and must be reviewed: the importer does not perform general secret detection. Client-side policy does not migrate with a connection.

MCP capabilities start empty, and `metadataInspected` remains false. Remote metadata can subsequently be populated with [batch refresh](batch-refresh.md). Registered stdio commands are not launched by default. The [import-management flow](import-management.md) adds explicit `--apply --refresh --inspect-stdio` authorization for consumer-side metadata inspection.

## Gemini A2A definitions

The importer reads YAML frontmatter, including remote-only lists, and ignores single local-agent definitions. Markdown instructions are not executed. YAML duplicate keys, aliases, and custom tags are rejected. A remote definition must choose one card representation:

- `agent_card_json`: parse the inline JSON card offline and preserve its declared HTTP execution interface, binding, version, and skills. An inline declaration is not evidence that the remote agent is reachable.
- `agent_card_url`: report `A2A_CARD_FETCH_REQUIRED` and keep the entry blocked by default. A card URL alone does not establish the task endpoint. Use `--fetch-a2a-cards` to allow the selected cards to be retrieved and inspected.

For a key returned by your preview:

```sh
agent-tcdh registry import-local --select gemini-cli-project-agents-research.md/researcher --fetch-a2a-cards
agent-tcdh registry import-local --select gemini-cli-project-agents-research.md/researcher --fetch-a2a-cards --apply
```

This explicit option can make outbound requests, even during preview. All selected declarations must first pass conversion checks. At most ten card lookups run sequentially, each with a 7.5-second deadline and existing response/redirect bounds. Only `auth.type: http`, `scheme: Bearer`, and `token: $VARIABLE` are portable; OAuth, Google credentials, API-key/Basic auth, literal tokens, and command-based values require manual configuration. Lookup credentials come only from that agent's declared variable, never the hub token. No A2A message/task or MCP tool call is sent. CLI/model installations are not automatically converted into A2A services.

`entries[].metadataInspected` identifies cards actually fetched. The top-level flag means at least one such inspection happened, not that every target was checked. `executionVerified` stays false. Apply rereads current source files and metadata; it is not bound to an earlier preview. Existing imports are not automatically synchronized when another client's settings later change.

## Bounds and failures

Sources must be regular UTF-8 files of at most 1 MiB each. Linked source files and linked A2A agent directories are rejected. The complete scan permits at most 128 source files, 8 MiB of source text, and 10,000 entries. Agent directories permit at most 1,000 immediate directory entries and 100 Markdown files each; one frontmatter list can contain at most 100 agents. Selection permits at most 1,000 keys. Existing snapshot byte/count limits also apply.

Missing files and files without a relevant container are reported without becoming imports. An invalid/unreadable source blocks a broad import. With explicit valid selections, unrelated unreadable sources become warnings; selected unsupported entries still block the entire application. Empty or blocked plans exit 1; ready previews and completed applications exit 0. Reports include source paths, entry names/keys, fixed issues, prepared definitions, environment variable names, and application/comparison results, not raw source files or parser/provider errors. Terminal output escapes source labels and paths; redirected output or `--json` is structured JSON.

## Inspected client documentation

Locations and adapters were checked on 2026-11-04 against [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [OpenCode configuration](https://opencode.ai/v2/docs/config/), [Gemini MCP](https://geminicli.com/docs/tools/mcp-server/), [Gemini remote A2A agents](https://geminicli.com/docs/core/remote-agents/), [Cursor MCP](https://cursor.com/docs/mcp), and [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

See [import management](import-management.md) for interactive selection, saved profiles, synchronization, optional follow-up, duplicate cleanup, and the explicit stdio startup path.
