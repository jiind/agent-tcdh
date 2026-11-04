# Import management release bundle — v0.1.5

Accumulate the following related improvements before the next release. Individual implementation commits or PRs do not trigger npm/GitHub publication.

- [x] Discover existing local MCP and Gemini A2A declarations (PR #24).
- [x] Interactive connection selection in a terminal.
- [x] Private reusable import profiles with explicit source locations and selectors.
- [x] Source tracking and conditional synchronization, including previewed optional pruning.
- [x] Optional post-import metadata refresh and diagnosis with per-target outcomes.
- [x] Registry-wide duplicate inspection and explicitly selected conditional removal.
- [x] Explicit consumer-side stdio metadata inspection with process cleanup and bounded resources.
Release gate: regression, installed-package, Linux/macOS/Windows, and container verification of the complete flow.
Publication gate: versioned release notes, exact-artifact verification, and one bundled publication. See the [release notes](releases/v0.1.5.md) and the linked GitHub Actions results for actual verification/publication status.

The hub remains a discovery registry. CLI inspection happens in the consuming environment; tool/task execution and model decisions remain with consumers. Local source files and credential values are not uploaded as synchronization state.
