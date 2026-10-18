import { matchingCheckpoint, parseMatchResponse, similarity, backendLabel } from './place-match';

const result = {
  reference_set: 'demo',
  decision: { outcome: 'likely_match', reference_id: 'r1', location_id: 'Studio 101', reasons: [] },
  candidates: [{ rank: 1, reference_id: 'r1', location_id: 'Studio 101', cosine: 0.4123 }],
  candidates_backend: 'megaloc:5fe0dd6:322x322',
  backend_used: 'megaloc',
  fallback_used: false,
  second_opinion_used: false,
  thresholds_id: 'sha256:abc',
  timings_ms: { total: 320 },
};

describe('place-match results', () => {
  it('parses a valid MegaLoc result', () => {
    const outcome = parseMatchResponse(
      { status: 200, body: JSON.stringify(result), roundTripMs: 400 },
      3,
    );
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') expect(backendLabel(outcome.result)).toBe('MegaLoc');
  });

  it('never turns an unexpected payload into a location', () => {
    const bad = parseMatchResponse(
      { status: 200, body: '{"decision":{"outcome":"here"}}', roundTripMs: 1 },
      1,
    );
    expect(bad.kind).toBe('error');
    const offline = parseMatchResponse({ status: 503, body: '', roundTripMs: 1 }, 1);
    expect(offline.kind === 'error' && offline.message).toContain('No matching backend');
    const malformedNode = parseMatchResponse(
      {
        status: 200,
        roundTripMs: 1,
        body: JSON.stringify({ ...result, matched_node: { node_id: 'unscoped-node' } }),
      },
      1,
    );
    expect(malformedNode.kind).toBe('error');
  });

  it('shows similarity as a raw score, not a percentage', () => {
    expect(similarity(0.33091)).toBe('0.331');
    expect(similarity(0.33091)).not.toContain('%');
  });

  it.each([
    ['index_not_ready', 'prepare its reference photos'],
    ['not_configured', 'has not been set up yet'],
    ['unavailable', 'temporarily offline'],
  ])('explains the %s service failure without presenting a location', (error, message) => {
    const outcome = parseMatchResponse(
      { status: 503, body: JSON.stringify({ error }), roundTripMs: 1 },
      1,
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain(message);
  });

  it('suggests a checkpoint only for an exact name match', () => {
    const nodes = [
      { id: 'n1', label: 'Studio 101' },
      { id: 'n2', label: 'Robotics Lab' },
    ];
    expect(matchingCheckpoint('studio-101', nodes)?.id).toBe('n1');
    expect(matchingCheckpoint('Studio', nodes)).toBeUndefined();
    expect(matchingCheckpoint(null, nodes)).toBeUndefined();
  });
});
