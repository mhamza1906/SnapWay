/**
 * Typed results from the place-match mobile API (engine `/v1/match`, or SnapWay
 * `/api/navigation/localize/`). MegaLoc decides first; Vertex AI is a fallback or a
 * verified second opinion. Scores are raw cosine similarity: never show them as `%`.
 */
export type MatchBackend = 'auto' | 'megaloc' | 'vertex';
export type MatchDecisionOutcome = 'likely_match' | 'uncertain' | 'no_supported_match';

export interface MatchCandidate {
  rank: number;
  reference_id: string;
  location_id: string | null;
  cosine: number;
}

export interface DetectedNode {
  node_id: string;
  stable_id: string;
  revision_id: string;
  target_id: string;
  label: string;
  kind: string;
  floor_id: string;
  floor_name: string;
  building_id: string;
  building_name: string;
}

export interface MatchResult {
  matched_node?: DetectedNode | null;
  node_id?: string | null;
  revision_id?: string | null;
  target_id?: string | null;
  building_id?: string | null;
  floor_name?: string | null;
  localization_token?: string | null;
  reference_set: string;
  decision: {
    node_id?: string | null;
    revision_id?: string | null;
    outcome: MatchDecisionOutcome;
    reference_id: string | null;
    location_id: string | null;
    reasons: string[];
  };
  candidates: MatchCandidate[];
  candidates_backend: string | null;
  backend_used: string;
  fallback_used: boolean;
  second_opinion_used: boolean;
  thresholds_id: string;
  timings_ms: Record<string, number>;
  verification?: { status: string; n_inliers?: number } | null;
  secondary?: {
    backend: string;
    error: string | null;
    candidates: MatchCandidate[];
  } | null;
}

export type MatchOutcome =
  | { kind: 'result'; clientFrameId: number; roundTripMs: number; result: MatchResult }
  | { kind: 'error'; clientFrameId: number; status: number; message: string };

export const OUTCOME_LABEL: Record<MatchDecisionOutcome, string> = {
  likely_match: 'Likely match',
  uncertain: 'Uncertain',
  no_supported_match: 'No supported match',
};

const OUTCOMES = new Set<string>(Object.keys(OUTCOME_LABEL));

const STATUS_MESSAGE: Record<number, string> = {
  0: 'Cannot reach photo matching. Check your connection and try again.',
  401: 'The server rejected the token. Check debug settings.',
  403: 'Not allowed to localize with this account.',
  409: 'The map changed. Take another photo.',
  413: 'The frame was too large for the server.',
  415: 'The server accepts JPEG frames only.',
  429: 'Too many frames; wait a moment and try again.',
  502: 'The localization service is misconfigured.',
  503: 'No matching backend is available right now.',
};

const UNAVAILABLE_MESSAGE: Record<string, string> = {
  index_not_ready:
    'Photo matching is not ready for this building yet. The map team needs to prepare its reference photos.',
  not_configured: 'Photo matching has not been set up yet. Please contact the map team.',
  unavailable: 'Photo matching is temporarily offline. Please try again later.',
};

/** Raw cosine with three decimals. Deliberately not a percentage or a confidence. */
export function similarity(cosine: number): string {
  return Number.isFinite(cosine) ? cosine.toFixed(3) : '—';
}

export function backendLabel(result: MatchResult): string {
  if (result.second_opinion_used) return 'MegaLoc + Vertex AI second opinion';
  if (result.backend_used === 'vertex')
    return result.fallback_used ? 'Vertex AI (MegaLoc unavailable)' : 'Vertex AI';
  return 'MegaLoc';
}

function isCandidate(value: unknown): value is MatchCandidate {
  const c = value as MatchCandidate;
  return !!c && typeof c.reference_id === 'string' && typeof c.cosine === 'number';
}

function isDetectedNode(value: unknown): value is DetectedNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return [
    'node_id',
    'stable_id',
    'revision_id',
    'target_id',
    'label',
    'kind',
    'floor_id',
    'floor_name',
    'building_id',
    'building_name',
  ].every((key) => typeof node[key] === 'string' && (node[key] as string).length > 0);
}

function isResult(value: unknown): value is MatchResult {
  const r = value as MatchResult;
  return (
    !!r &&
    !!r.decision &&
    (r.matched_node == null || isDetectedNode(r.matched_node)) &&
    OUTCOMES.has(r.decision.outcome) &&
    Array.isArray(r.decision.reasons) &&
    Array.isArray(r.candidates) &&
    r.candidates.every(isCandidate) &&
    typeof r.backend_used === 'string' &&
    typeof r.thresholds_id === 'string'
  );
}

/** Turns a native HTTP result into a typed outcome; anything unexpected is an error, never a location. */
export function parseMatchResponse(
  http: { status: number; body?: string; roundTripMs: number },
  clientFrameId: number,
): MatchOutcome {
  let payload: unknown = null;
  try {
    payload = http.body ? JSON.parse(http.body) : null;
  } catch {
    payload = null;
  }
  if (http.status === 200 && isResult(payload)) {
    return { kind: 'result', clientFrameId, roundTripMs: http.roundTripMs, result: payload };
  }
  const detail =
    payload && typeof payload === 'object'
      ? String((payload as { detail?: unknown }).detail ?? '')
      : '';
  const code =
    payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : null;
  const unavailableMessage =
    http.status === 503 && typeof code === 'string' ? UNAVAILABLE_MESSAGE[code] : undefined;
  const message =
    STATUS_MESSAGE[http.status] ??
    (http.status === 200
      ? 'The server returned an unexpected response.'
      : `Server error ${http.status}.`);
  return {
    kind: 'error',
    clientFrameId,
    status: http.status,
    message:
      unavailableMessage ??
      (detail && http.status !== 401 ? `${message} ${detail}`.slice(0, 240) : message),
  };
}

/** Suggest a map checkpoint only when a location id names it exactly (case and spacing ignored). */
export function matchingCheckpoint<T extends { id: string; label: string }>(
  locationId: string | null,
  checkpoints: T[],
): T | undefined {
  if (!locationId) return undefined;
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wanted = key(locationId);
  return checkpoints.find((node) => key(node.id) === wanted || key(node.label) === wanted);
}
