# Model-driven selection of multiple targets

On 2026-10-27, actual Codex CLI runs selected and directly executed the providers needed for three and five requested tasks. Only the hub was configured as a native MCP server. The agent received task descriptions and input values, without target IDs, URLs, or a prescribed mapping to MCP versus A2A.

| Requested targets | Registry candidates | MCP executions | A2A executions | Unrelated execution attempts | Result |
| --- | --- | --- | --- | --- | --- |
| 3 | 10 | 2 | 1 | 0 | Passed |
| 5 | 10 | 3 | 2 | 0 | Passed |

Both runs used `codex-cli 0.164.0` and `gpt-6.1-sol`. The three-target run made one hub search and three target lookups; the five-target run made one search and five lookups. Every selected target executed exactly once. Final response values, JSON types, and unpredictable execution receipts matched the target records. A trace audit confirmed zero execution attempts against unselected targets, including the explicit mutating decoys.

## What was tested

The harness registers eight narrowly scoped calculation/text providers and two unrelated deletion decoys in a real hub. Registration order and target IDs are randomized; MCP/A2A assignments vary while the requested set includes both protocols for counts greater than one. Candidate metadata describes capabilities and input schemas. The consumer must search the hub, retrieve the selected definitions, follow the registered connection and authentication references, and execute the requested tasks directly.

The prompt supplies the goals and actual inputs, such as adding a list of costs or removing duplicate strings. It does not name a provider to call. A fresh challenge and receipts generated only during valid execution prevent a computed answer or guessed receipt from passing. The verifier compares each final result with the corresponding server execution, and records discovery and target protocol traffic independently.

The MCP and A2A targets in this selection test are controlled local fixtures. The A2A peers implement Agent Card discovery and A2A 0.3 JSONRPC data messages; they do not run additional language models. Separate [public MCP verification](public-mcp-verification.md) demonstrates real external documentation services. The two tests provide different evidence and are not a single combined public-service/remote-model trial.

## Reproduce

Requires a logged-in Codex CLI and an available model. This is an explicit real model run and consumes the account's model allowance.

```sh
npm run test:selection -- --count 3 --model gpt-6.1-sol
npm run test:selection -- --count 5 --model gpt-6.1-sol
npm run test:selection -- --count 8 --model YOUR_AVAILABLE_MODEL \
  --output /absolute/path/to/new-evidence-directory
```

Use `--workflow summary-batch` to exercise the compact discovery flow:

```sh
npm run test:selection -- --count 5 --model YOUR_AVAILABLE_MODEL --workflow summary-batch
```

The audit requires exactly one summary search with required inputs, the fixture tag, and bearer authentication. It then requires one `get_targets` call containing precisely the chosen IDs. It records search and lookup counts, missing IDs, unrelated IDs, and target receipts. The default regression suite exercises the audit against synthetic events, including wrong IDs and redundant queries. The model results above used the single-lookup workflow.

`--count` accepts 1 through 8 for this fixture catalog. Counts 3 and 5 were actually observed; the other accepted counts are not claimed as observed results. An explicit output directory must be new. The harness starts temporary hub/target listeners, supplies isolated per-run MCP configuration, captures redacted CLI output and request traces, validates receipts, and stops its processes. Personal agent configuration is unchanged. It does not automatically run in CI or switch to a different model if the selected model fails.

## Interpretation

The current implementation supports an agent choosing multiple matching MCP/A2A targets from one registry and executing them directly, provided the consumer can use the returned protocols and has the required permissions. Selection happens in the consuming agent. The hub performs keyword search, filters, pagination, and metadata lookup; it does not run a planner or execute tools.

In these Codex runs, native MCP tools provided hub discovery, and the agent wrote HTTP clients inside its temporary workspace to execute selected targets. This does not demonstrate automatic mounting of discovered targets as native Codex tools. It also does not establish an unlimited target count, reliable selection for every ambiguous request, all A2A versions, long-running tasks, dependency scheduling, public A2A service compatibility, or every commercial agent.

## Evidence

- [Run summaries and trace audits](evidence/selection-20261027.json)
- [Three-target protocol trace](evidence/selection-3-20261027-events.json)
- [Five-target protocol trace](evidence/selection-5-20261027-events.json)
- [Verification harness](../scripts/verify-selection.mjs)
