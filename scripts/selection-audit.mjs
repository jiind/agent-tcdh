import assert from "node:assert/strict";

/** Require one filtered summary search followed by one exact batch retrieval. */
export function auditSummaryBatch(calls, selectedIds, tag, record = {}) {
  const searches = calls.filter((event) => event.tool === "search_targets");
  const singles = calls.filter((event) => event.tool === "get_target");
  const batches = calls.filter((event) => event.tool === "get_targets");
  const lookupIds = [...singles.map((event) => event.targetId), ...batches.flatMap((event) => event.targetIds ?? [])];
  const requestedIds = new Set(selectedIds);
  Object.assign(record, { hubSearchCalls: searches.length, hubGetCalls: singles.length, hubBatchGetCalls: batches.length,
    unrelatedLookupIds: lookupIds.filter((id) => !requestedIds.has(id)),
    missingLookupIds: selectedIds.filter((id) => !lookupIds.includes(id)),
    verifiedSearchFilters: searches.map(({ search }) => search) });
  assert.equal(searches.length, 1, "Use one summary search to compare the candidates.");
  assert.equal(searches[0].search?.view, "summary", "Use the compact summary view.");
  assert.equal(searches[0].search?.tag, tag, "Apply the fixture tag filter.");
  assert.equal(searches[0].search?.auth, "bearer", "Apply the bearer authentication filter.");
  assert.equal(searches[0].search?.inputs, true, "Request required input previews.");
  assert.equal(singles.length, 0, "Use a single batch lookup without individual lookups.");
  assert.equal(batches.length, 1, "Retrieve the selected IDs in one batch.");
  assert.ok(calls.indexOf(searches[0]) < calls.indexOf(batches[0]), "Discover candidates before retrieving the batch.");
  assert.deepEqual([...lookupIds].sort(), [...selectedIds].sort(), "The batch must contain each selected ID exactly once.");
  return record;
}
