# More MCP client connections

Requires AgentTCDH `0.1.2` or later. Build a source checkout with `npm ci` and `npm run build`; replace `agent-tcdh` below with `node dist/index.js` when working from source. See the [v0.1.2 release notes](releases/v0.1.2.md) for installation and publication checks.

## Generate a connection

```sh
agent-tcdh connect claude-code --print
agent-tcdh connect gemini-cli --print
agent-tcdh connect cursor --print
agent-tcdh connect vscode --print
```

Each profile produces one hub connection. It launches this installation's existing `mcp` discovery bridge through an absolute Node.js executable and CLI file path. The bridge queries the shared registry over HTTP and exposes `search_targets` and `get_target` over stdio. It does not start a hub, launch registered targets, or relay their tools/tasks. Changes in registrations become visible on the next lookup.

| Profile | JSON server container | Example explicit destination | Credential reference |
| --- | --- | --- | --- |
| `claude-code` | `mcpServers` | `/path/to/project/.mcp.json` | `${NAME}` in `env` |
| `gemini-cli` | `mcpServers` | `/path/to/project/.gemini/settings.json` | `${NAME}` in `env` |
| `cursor` | `mcpServers` | `/path/to/project/.cursor/mcp.json` | `${env:NAME}` in `env` |
| `vscode` | `servers` | `/path/to/project/.vscode/mcp.json` | `${env:NAME}` in `env` |

`vscode` produces the VS Code editor `servers` format. Current Copilot harness configuration also has a separate portable `mcpServers` format and its own configuration destinations. This profile does not select a harness or configure Copilot CLI/cloud sessions. Confirm that your chosen client destination accepts the format; follow the linked VS Code reference for current harness behavior.

These are machine-specific launch paths. Generate settings in the environment where the client runs, including remote workspaces and containers. Regenerate them after moving the checkout/package or replacing the Node installation. Keep the built CLI available. The generator does not download another package, guess an agent installation, or choose a personal configuration path. It refuses launch paths containing `${` rather than allowing client interpolation to reinterpret them.

The existing `codex`, `opencode`, and `opencode-v1` profiles continue to generate direct Streamable HTTP hub connections. The new profiles use the existing local bridge to share its explicit credential handling without depending on client-specific HTTP authentication behavior. Target execution continues directly from the consuming environment.

| Direct HTTP profile | Configuration layout | Credential reference |
| --- | --- | --- |
| `codex` | TOML `mcp_servers.<name>` | `bearer_token_env_var` |
| `opencode-v1` | JSONC `mcp.<name>` | `Bearer {env:NAME}` header |
| `opencode` for OpenCode 2.x | JSONC `mcp.servers.<name>` | `Bearer {env:NAME}` header |

The regression suite parses each generated layout, connects an MCP SDK client to an authenticated loopback hub, and completes a first summary search. To record a native OpenCode binary's initialization, run `npm run test:agents -- --agent opencode --connection-only`. The harness selects the generated profile by the installed major version and records the version, profile, and authenticated initialization. Model-driven native search uses the separate opt-in execution harness.

## Merge into a selected file

```sh
agent-tcdh connect claude-code --write /path/to/project/.mcp.json --dry-run
agent-tcdh connect claude-code --write /path/to/project/.mcp.json
agent-tcdh connect gemini-cli --write /path/to/project/.gemini/settings.json
agent-tcdh connect cursor --write /path/to/project/.cursor/mcp.json
agent-tcdh connect vscode --write /path/to/project/.vscode/mcp.json
```

`--write FILE` is explicit application. Preview with `--dry-run` first when a file already exists. JSONC merging preserves unrelated entries, settings, comments, and a UTF-8 BOM. Replacements keep an exact backup. Identical settings are a no-op; a conflicting named entry requires `--replace`, or use `--name` to add a different connection. A file containing only the other known server container is rejected instead of receiving an unused entry.

Use `connect CLIENT --write FILE --plan` to preview a conflicting entry before authorizing replacement. The plan reports an add, an unchanged entry, or a replacement and lists the recognized fields whose settings differ. It reveals neither the previous values nor stored credential values.

The normal result describes transport, required variable names, and next steps. It does not echo unrelated file content. `--print` emits only the new fragment, even when redirected. The generator does not enable automatic tool approvals or modify client trust policies. Reload the selected client and complete its normal setup/trust requirements.

## Pass a selected credential

```sh
agent-tcdh connect gemini-cli --hub https://hub.example.com --token-env HUB_READER --print
```

The selected name follows [guided setup credential precedence](onboarding.md#credential-references), preferring a saved read reference. Its value is never read or embedded during generation. Set that variable in the client environment before launching the bridge. A missing selected variable fails instead of falling back to an administrator token.

Each profile explicitly maps its one selected environment variable. This also accommodates Gemini CLI's documented sanitization of sensitive inherited variables. The client resolves the placeholder; the bridge receives the value and uses it only for hub access. Provider credentials remain separate in the environment that executes a discovered target.

Generated arguments include `--no-config`, so the bridge ignores personal/default setup files and `AGENT_TCDH_CONFIG`. The explicit `--hub` pins the destination. If no credential name is selected, arguments include `--anonymous`; the bridge then ignores inherited hub credentials. These options apply only to `mcp`. `--anonymous` conflicts with `--token-env`, and `--no-config` conflicts with `--config`. Ordinary `mcp` without these flags retains its existing behavior.

When importing a portable `mcpServers` file into the same hub, configuration import excludes this installation's exact generated bridge before converting other entries. Different installations or modified commands are not guessed to be self references. VS Code `servers` configuration import is not implemented by these new connection profiles.

## Use and verify discovery

After loading the connection, ask your agent:

> Search AgentTCDH for capabilities relevant to my task, retrieve the current target definitions, and connect directly to the selected MCP servers or A2A agents using their declared protocols and my available credentials and permissions.

A hub connection makes discovery available. It does not guarantee that a client can mount newly discovered native tools during a running session or speak A2A. The consuming agent still owns selection, protocol support, credentials, permissions, and execution.

Tests cover generated structure, placeholders, JSONC merging, backups, and actual generated Node/CLI invocations through the official MCP SDK against isolated authenticated hub fixtures. They verify registration additions/removals without reconnecting. Installed-package verification launches a generated bridge outside the repository. These are SDK/fixture checks, not claims of new native Claude/Gemini/Cursor/VS Code model executions. No personal agent configuration or external model accounts are used.

Profile formats were checked against the following official documentation on 2026-10-29: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), [Cursor MCP](https://prod.cursor.com/docs/mcp), and [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
