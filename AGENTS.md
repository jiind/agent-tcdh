# Project conventions

Use English for project documentation, code comments, test names, examples, CLI output, API diagnostics, and agent instructions. Preserve unmodified third-party metadata and evidence, and keep intentional non-English fixtures that test Unicode behavior. Conversation with contributors may use their preferred language.

AgentTCDH is a capability and connection registry. Consumers discover targets through MCP, A2A, or HTTP, then execute directly against the target. Keep protocol execution, model decisions, credentials, and permissions in the consuming environment. Public-provider verification profiles are examples, not a registry allowlist.

Run `npm run check` for relevant code changes. Packaging verification is `npm run test:package`. Keep external MCP calls and real model runs opt-in: `test:public-mcp`, `test:agents`, `test:selection`, and `test:model-targets` must not run automatically in the default suite or CI. Do not modify personal agent configuration during verification. Record failures and distinguish fixture execution from live provider execution and actual model-driven selection.

Preserve native Linux, macOS, and Windows compatibility. Use portable command spawning for npm/agent shims, platform-appropriate process cleanup, and Node path utilities. Keep the OS CI matrix current and distinguish executed native checks from static analysis or configured-but-unrun jobs.

Accumulate related user-facing improvements into a cohesive release rather than publishing after each feature PR. The current environment-management bundle is tracked in `docs/roadmap.md`; complete and verify its agreed scope before preparing the next version.
