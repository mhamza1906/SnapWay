import type { ActiveSession, CapturePoint } from './capture.models';

// The active session and its points are also kept on the phone (localStorage, small JSON),
// so a refresh or a dead zone never loses planned or adjusted points. Photos live in the
// upload queue (IndexedDB), not here.

export interface SessionDraft {
  session: ActiveSession;
  points: CapturePoint[];
  corridorLabel: string;
  savedAt: string;
}
export interface DraftSummary {
  id: string;
  buildingId: string;
  floorId: string;
  corridorId: string;
  corridorLabel: string;
  direction: string;
  savedAt: string;
}

const PREFIX = 'snapway.capture.draft.v1.';
const INDEX = 'snapway.capture.drafts.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function listDrafts(): DraftSummary[] {
  try {
    const raw = storage()?.getItem(INDEX);
    const list = raw ? (JSON.parse(raw) as DraftSummary[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function loadDraft(id: string): SessionDraft | null {
  try {
    const raw = storage()?.getItem(PREFIX + id);
    return raw ? (JSON.parse(raw) as SessionDraft) : null;
  } catch {
    return null;
  }
}

/** Saves the draft; returns false when the phone's storage refuses it. */
export function saveDraft(draft: SessionDraft): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(PREFIX + draft.session.id, JSON.stringify(draft));
    const b = draft.session.body;
    const summary: DraftSummary = {
      id: draft.session.id,
      buildingId: b.mapBuildingId,
      floorId: b.mapFloorId,
      corridorId: b.corridorId,
      corridorLabel: draft.corridorLabel,
      direction: b.direction,
      savedAt: draft.savedAt,
    };
    const rest = listDrafts().filter((d) => d.id !== summary.id);
    s.setItem(INDEX, JSON.stringify([summary, ...rest].slice(0, 20)));
    return true;
  } catch {
    return false;
  }
}
