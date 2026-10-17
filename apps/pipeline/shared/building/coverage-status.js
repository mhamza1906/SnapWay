export function coverageSummary(floor, source) {
  const report = source.coverage;
  if (!report)
    return { audited: false, total: 0, mapped: 0, missing: [], excluded: [] };
  const expected = report.items.filter((i) => !i.excluded),
    excluded = report.items.filter((i) => i.excluded);
  const missing = expected.filter(
    (i) => !i.spaceId || !floor.geometry.spaces.some((s) => s.id === i.spaceId),
  );
  return {
    audited: true,
    total: expected.length,
    mapped: expected.length - missing.length,
    missing,
    excluded,
    complete:
      report.stage === "complete" &&
      !missing.length &&
      !report.failures?.length &&
      excluded.every((i) => i.reason?.trim()),
  };
}
