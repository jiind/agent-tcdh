# Search quality verification

Run the benchmark from a source checkout with locked dependencies installed:

```sh
npm run build
node scripts/verify-search.mjs
```

The benchmark creates in-memory SQLite registries with 100 and 1,000 entries each. Fourteen labeled queries cover exact IDs and names, similar capability descriptions, canonical Unicode and separator differences, protocol and tag filters, disabled targets, and queries with no relevant result. A separate group exercises four queries where the expected target has a single capability covering every term. The script reports the expected IDs, top three results, total matches, and quality counts per query. Each mode uses 10 warm-up passes and 30 measured passes. The p95 time measures registry searches, including SQLite reads and ranking. The benchmark uses local metadata fixtures and makes no network or model calls.

## Observed results

The initial comparison of exact ranking and normalized matching used commit `7151d3f` as its baseline. Both measurements used the same fixtures on macOS ARM64 with Node.js `v26.13.1`.

| Catalog size | Search | Relevant result in top 3 | Empty result with a relevant target | Results for queries with no relevant target | Exact ID or name first | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | Before | 4/10 | 3/10 | 0/4 | 0/2 | 0.621 ms |
| 100 | Exact ranking | 7/10 | 3/10 | 0/4 | 2/2 | 0.563 ms |
| 100 | Exact ranking with normalization | 10/10 | 0/10 | 0/4 | 2/2 | 0.707 ms |
| 1,000 | Before | 4/10 | 3/10 | 0/4 | 0/2 | 4.754 ms |
| 1,000 | Exact ranking | 7/10 | 3/10 | 0/4 | 2/2 | 4.304 ms |
| 1,000 | Exact ranking with normalization | 10/10 | 0/10 | 0/4 | 2/2 | 6.338 ms |

Repeated partial matches previously pushed the exact deployment ID, release-notes name, and invoice-export capability out of the top three. Exact-field ranking recovered these three. The opt-in mode also recovered the underscore-separated support-ticket and Korean deployment-guide queries and the decomposed-accent French/Korean query. Both modes passed the filter cases. Use the latency values as a local comparison under the stated runtime and fixture load.

Protocol tests cover the new matching option over HTTP, MCP, and both supported A2A versions. The package verifier reads a generated Codex connection, then uses an MCP SDK client to find the just-imported registration. Model-driven selection and target execution are covered by separate [verification workflows](selection-verification.md).

## Queries with one matching capability

Each query matched five targets. Four directories scattered the terms across multiple capabilities and carried them in their target names and tags. The expected target covered every term in one capability's name and description. The cases include inventory reservation, emailed tax receipts, a mixed Korean and English audit-log query, and PDF table extraction.

| Catalog size | Search mode | Expected target first before | Expected target first after | p95 before | p95 after |
| --- | --- | ---: | ---: | ---: | ---: |
| 100 | Literal | 0/4 | 4/4 | 0.684 ms | 0.564 ms |
| 100 | Normalized | 0/4 | 4/4 | 0.916 ms | 0.934 ms |
| 1,000 | Literal | 0/4 | 4/4 | 5.153 ms | 3.645 ms |
| 1,000 | Normalized | 0/4 | 4/4 | 7.001 ms | 6.434 ms |

Both runs used macOS ARM64 and Node.js `v26.13.1`. All four queries still matched the same five targets. The original query group retained its 7/10 literal and 10/10 normalized top-three counts. Exact whole-query matches still take precedence over single-capability coverage.

## Suggestions for empty searches

On both the 100- and 1,000-target catalogs, four queries with one additional term produced zero complete matches and ranked the expected target first in `suggestions`. The response identified `yearly`, `verified`, `보관`, and `spreadsheet` as the respective missing terms. Two queries with fewer than two matching terms produced empty suggestion lists. The original query outcomes and summary response sizes matched the previous build.

Regression coverage also checks the suggestion limit, connection and tag filters, disabled targets, and suppression on later pages or when complete matches exist. The CLI presents suggestions separately and reports which term each target missed.

## Summary response size

The benchmark also compares a full result page, a summary page, and a summary followed by one complete lookup. Both views returned the same ranked IDs in each example. Sizes are bytes of serialized JSON before transport framing or compression.

| Catalog and query | Results | Full page | Summary page | Summary and one lookup | Reduction with lookup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Saved public documentation snapshot, `documentation` | 6 | 22,697 | 2,995 | 4,380 | 80.7% |
| Same snapshot and query with `transport=streamable-http` and `auth=none` | 5 | 15,297 | 2,762 | 4,147 | 72.9% |
| Synthetic usage catalog with 30 capabilities per target, `usage` | 20 | 371,764 | 21,401 | 39,985 | 89.2% |

The packaged snapshot is read from disk for this comparison. The connection filters retained five remote registrations in their original order and excluded the one stdio registration. This comparison uses declared transport and authentication metadata. The byte counts depend on the registered descriptions, schemas, and the number of full lookups a consumer makes.

## Ordered batch lookup

The deployed smoke check sends two existing IDs and one missing ID in one batch over each discovery interface. HTTP, MCP, and both A2A versions return the same metadata in request order, with `null` in the middle for the missing ID. Package verification also checks the installed CLI with only the selected hub's read token available. The fixtures verify the lookup contract. The historical [model-driven selection runs](selection-verification.md) used individual target lookups.

## Large catalog search

```sh
npm run build
node scripts/verify-search-scale.mjs
```

The scale benchmark creates a temporary file-backed SQLite registry with 4,000 targets and ten capability input schemas per target. The database was 111 MiB and 3,600 targets were enabled. The optional `--baseline PATH_TO_BUILT_STORE_JS` runs a comparison on the same database and checks that both builds return identical page IDs, in the same order, and the same total. Each run uses a fresh process with five warm-up queries and twenty timed queries. Peak RSS includes the Node runtime and SQLite. The reported latency covers the store query.

| Query on macOS ARM64 with Node.js `v26.13.1` | p95 before | p95 after | Peak RSS before | Peak RSS after |
| --- | ---: | ---: | ---: | ---: |
| Browse first summary page | 485.707 ms | 12.031 ms | 878.0 MiB | 76.1 MiB |
| Rank first summary page | 502.866 ms | 447.912 ms | 985.5 MiB | 151.5 MiB |
| Rank a normalized query at offset 1,400 | 504.526 ms | 446.290 ms | 901.2 MiB | 152.8 MiB |

Unranked browsing with only enabled-state or protocol filters reads the total and requested page directly in SQLite. Ranked discovery scans definitions one at a time, retains IDs and scores, and reads the full page inside the same SQLite snapshot. A regression test writes a new definition between ranking and page hydration and checks that the page still returns the earlier definition. The 100- and 1,000-target fixtures also returned the same ranked outcomes and summary payloads as the preceding build.

### Compact metadata projection

The next iteration stores a compact searchable projection in SQLite. Ranking reads IDs, labels, descriptions, and capability names and descriptions. It loads complete definitions for the returned page and any suggestions. SQLite backfills the projection on first opening an existing registry and updates it transactionally. The same transaction advances a generation marker used by pagination cursors.

The following rerun compares the compact projection with the archived baseline build on the same 116.3 MiB database. Each scenario preserved the total of 3,600 enabled targets and the exact page IDs in the same order.

| Query on macOS ARM64 with Node.js `v26.13.1` | Baseline p95 | Compact p95 | Baseline peak RSS | Compact peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Browse first summary page | 427.210 ms | 12.343 ms | 619.6 MiB | 76.3 MiB |
| Rank first summary page | 468.322 ms | 56.357 ms | 986.6 MiB | 144.7 MiB |
| Rank a normalized query at offset 1,400 | 518.854 ms | 110.842 ms | 987.3 MiB | 151.3 MiB |

## Initial build and runtime verification

| Environment | Result |
| --- | --- |
| Native macOS ARM64, Node.js `v26.13.1` | `npm run check` passed all 299 tests. `npm run test:package -- --offline` passed, including the installed CLI's empty-search suggestions and the deployed protocol checks. |
| Linux ARM64 container, Node.js 24 base image | The Dockerfile build and `npm run test:container` passed. The smoke check verified the non-root runtime, health, authenticated discovery, and persistence after restart. HTTP, MCP, A2A 1.0, and A2A 0.3 agreed on search suggestions before and after restart. |
| Native Linux x64, macOS Intel, and Windows x64 | Configured in the CI matrix. These jobs have no results for this working-tree revision. |

The first sandboxed regression run was blocked from opening loopback listeners. The full run passed with loopback access. The isolated container VM required network access to download its base disk image.

The initial package verification for suggestions timed out in npm. An offline retry with cached dependencies passed. The first container run reported `EPERM` during timeout cleanup. A separate retry with the same image passed after restarting the isolated VM and removing the earlier test resources.

## Follow-through verification on 2026-11-23

| Environment | Result |
| --- | --- |
| Native macOS ARM64, Node.js `v26.13.1` | `npm run check` passed all 309 tests. The installed-package verifier passed with cached dependencies. A pseudo-terminal selected two targets and received their full definitions in order after one batch request. Generated Bash and Zsh scripts loaded and offered the expected search-profile candidates. |
| Linux ARM64 container, Node.js 24 base image | The Dockerfile build and `npm run test:container` passed. HTTP, MCP, A2A 1.0, and A2A 0.3 returned the same explained discovery data before and after restart. The test also verified non-root execution, health, authentication, and volume persistence. |
| Native Linux x64, macOS Intel, Windows x64, and PowerShell | Native Linux x64, macOS Intel, and Windows x64 jobs are configured and were not run for this revision. The macOS suite checked PowerShell script generation. The script was not loaded by a PowerShell runtime. |

An initial sandboxed run could not open loopback listeners. The full regression and installation runs used loopback access. Direct Codex and OpenCode layout tests connected with the MCP SDK. The new real-model summary-and-batch workflow and native OpenCode verification remain opt-in and were not run for this revision.
