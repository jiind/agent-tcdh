# Import client configurations and presets

Requires AgentTCDH `0.1.2` or later. From source, run `npm ci` and `npm run build` first; examples below use `node dist/index.js` from the repository root. An installed package uses `agent-tcdh` instead. See the [v0.1.2 release notes](releases/v0.1.2.md) for installation and publication checks.

Source checkouts also provide [local client discovery](local-import.md) to locate known user/project settings and Gemini A2A definitions automatically. That command is not included in `0.1.4`; the explicit-file command below keeps its original behavior.

## Bring existing MCP connections into the registry

Select an explicit source file. Importing never changes that file or scans personal configuration directories.

```sh
node dist/index.js registry import-config /path/to/config.toml
node dist/index.js registry import-config /path/to/config.toml --select docs --select search --prefix shared
node dist/index.js registry import-config /path/to/config.toml --select docs --select search --prefix shared --apply
```

The default is an offline preview. It reports source format, selected connections, proposed target IDs, required environment variable names, and per-entry warnings/errors. It does not contact the hub or targets, resolve credentials, launch commands, or inspect capabilities. `--dry-run` explicitly requests the same preview; it cannot be combined with `--apply`.

Repeat `--select NAME` to choose source server names, preserving source order. Without selections, all source entries are considered. Only selected entries are validated for conversion. A selected entry with an error blocks the entire application; choose supported entries or supply a manual definition for the others. A blocked or empty plan exits with code 1; a ready preview exits with code 0.

Use `--apply` to submit the prepared connections through the existing atomic registry import API. Administrator access is required. Preview does not check destination conflicts; the apply request checks them transactionally. `--on-conflict error` is the default and rolls back the whole import on an existing ID. `skip` keeps existing entries; `replace` overwrites matching definitions, including their capability lists. Targets absent from the import are retained.

Valid source names remain target IDs. Other names receive a normalized ID with a stable hash suffix. `--prefix shared` prepends `shared-`; prefixes use lowercase letters, digits, dots, underscores, and hyphens, start with a letter or digit, and have at most 32 characters. IDs have at most 128 characters. Preview shows the final IDs before application. An exact connection to the destination hub's own `/mcp` URL is excluded to avoid registering its discovery interface as its own target.

### Supported source layouts

Auto-detection requires one recognized root container. Use `--format` to resolve ambiguity or choose a specific layout.

| Format | Root | Local process | Remote |
| --- | --- | --- | --- |
| `codex` | TOML `mcp_servers.NAME` | String `command`, array `args`, `env`, `env_vars` | `url`, `bearer_token_env_var`, supported `http_headers` |
| `opencode` | JSON/JSONC `mcp.servers.NAME` | `type: local`, command array, `environment` | `type: remote`, `url`, supported `headers` |
| `opencode-v1` | JSON/JSONC `mcp.NAME` | Same command layout as v2 | Same remote layout as v2 |
| `mcp-json` | JSON/JSONC `mcpServers.NAME` | String `command`, array `args`, `env` | `url`, `type: http` or `sse`, supported `headers` |

JSONC comments and trailing commas are accepted. OpenCode v2 `disabled` and v1/Codex `enabled` are preserved. Generic `mcp-json` accepts either boolean `enabled` or `disabled`, but not both. A generic remote entry without a `type` assumes Streamable HTTP and produces a warning. The portable `mcp-json` subset does not promise full compatibility with every client's extensions or interpolation syntax.

The source must be a regular UTF-8 file, not a symlink, at most 1 MiB, containing at most 10,000 server entries. Existing registry snapshot limits also apply.

### Credentials and consumer settings

Inline `env`/`environment` values are omitted. The resulting stdio definition declares variable names in `envVars`; supply their values in each consumer environment. OpenCode `{env:NAME}` is retained when the destination variable has the same name. Aliases, remote environment sources, and other substitutions require manual configuration.

For remote connections, a Codex `bearer_token_env_var` or OpenCode `Authorization: Bearer {env:NAME}` retains a variable reference. An inline Bearer token is omitted and replaced with a proposed `MCP_<TARGET_ID>_TOKEN` variable name. Supply the raw token in that variable. Custom headers, dynamic header helpers, unsupported substitutions, and explicit client-managed OAuth settings block conversion. Authentication that is not declared is reported as uninspected; the consumer still establishes any required login.

Remote URLs containing user information, query strings, or fragments are rejected. Working directories and remote executor placement are also rejected because the registry cannot represent their execution context. Client tool filters remain client-side and produce a warning.

**Review command arguments before applying.** They are copied literally and may contain paths or values specific to the original environment. Common credential flags and client-specific argument substitutions are rejected, but this is not a general secret detector. Keep credential values out of arguments and use consumer-side environment references.

Imported connections have empty capability lists and the `imported-config` tag. The import report records `metadataInspected: false` and `executionVerified: false`. They are searchable by ID/name/description/tag immediately. After registering, remote metadata can be inspected separately using `target check ID` or populated using `target refresh ID`. These operations may contact the provider; they do not execute its tools or tasks. Stdio metadata inspection remains unsupported. The hub continues to return connection metadata for direct consumer execution.

## Start from a packaged preset

Presets are bundled example snapshots, so their location does not depend on the current working directory.

```sh
node dist/index.js preset list
node dist/index.js preset show public-docs --select openai-docs --select microsoft-learn
node dist/index.js preset import public-docs --select openai-docs --select microsoft-learn
node dist/index.js preset import public-docs --select openai-docs --select microsoft-learn --prefix docs --apply
```

`preset show` and `preset import` without `--apply` are offline previews. Selection uses the target IDs shown by `preset list`. Prefixes and conflict policies work as with configuration import. Applications use the same atomic registry API. Lists and previews report the original snapshot date as `metadataAsOf`; they do not claim a new provider inspection. `metadataInspected` and `executionVerified` remain false for this operation.

The `public-docs` preset contains Cloudflare Docs, Context7, DeepWiki, Microsoft Learn, OpenAI Docs, and Toss Payments Docs. Toss's pinned stdio command is only recorded; consumers launch it when needed. A provider may have changed since the recorded observation. Verify current metadata and actual execution separately when needed.

Presets are convenience collections, not a provider allowlist. Arbitrary MCP and A2A targets remain supported through the [normal definition and metadata import interfaces](reference.md#search-and-connection-definitions). Client configuration import currently converts MCP connections; it does not infer A2A endpoints from agent client settings.

## Compare with the current hub

Add `--compare` to configuration/preset previews for an online read-only comparison, or use `registry diff FILE` for a snapshot. [Registry comparison](registry-comparison.md) explains changed fields, policy-specific conflicts, detailed JSON, and consistency. Default previews remain offline. Comparison cannot be combined with `--apply`.

## Output and references

Use `--json` for structured output in a terminal; redirected output is JSON by default. `applied` reports whether an import request completed. With `skip`, this may include entries the hub retained unchanged; inspect `result` for the actual counts. `hubConflictsChecked` is false for offline previews; online comparison marks observed destination conflicts but does not lock a later import.

Hub URL and credential references use the [guided setup precedence](onboarding.md). `--hub URL` overrides the destination. Sources: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [OpenCode v2 MCP configuration](https://opencode.ai/v2/docs/mcp-servers/), and [OpenCode v1 MCP configuration](https://opencode.ai/docs/en/mcp-servers/).
