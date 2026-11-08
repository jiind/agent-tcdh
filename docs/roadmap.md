# Environment management release bundle — v0.1.6

Bundle the following related improvements into one publication. Individual commits or PRs do not trigger a release.

- [x] Private named hub profiles with read/admin credential references and explicit activation.
- [x] Import-profile selection and source-location editing while retaining ownership.
- [x] Unified registry, source-drift, environment, and stored-metadata status.
- [x] Revision-bound freshness with explicit stale-target inspection and optional refresh.
- [x] Transactional bounded registry history and guarded single-target undo.
- [x] Guided source selection, registration, profile saving, and explicit consumer connection output.

Release gate: typecheck/regression, installed-package coverage of all six workflows, native Linux/macOS/Windows, and container verification. Publication gate: normal protected PR merge, exact-artifact verification, versioned release notes, GitHub release, and public npm installation verification. Actual results belong in the release evidence, not inferred from these implementation checkboxes.

Next candidates, outside this bundle: additional client adapters/profile locations and optional source-change notifications. The completed v0.1.5 import-management bundle is described in [its release notes](releases/v0.1.5.md).

The hub stays a capability/connection registry. Provider inspection runs only in an explicitly authorized consumer process; tools and A2A tasks remain direct consumer execution.
