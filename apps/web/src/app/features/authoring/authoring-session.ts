import { Injectable, signal } from '@angular/core';
import type { BuildingSummary, PipelineBuilding } from './pipeline.service';

/**
 * The building open in the map authoring screen, kept for the whole app session so
 * leaving the page (another workspace section) and coming back keeps it loaded.
 * In memory only: a reload starts empty, as nothing is saved until "Save a copy".
 */
@Injectable({ providedIn: 'root' })
export class AuthoringSession {
  readonly building = signal<PipelineBuilding | null>(null);
  readonly summary = signal<BuildingSummary | null>(null);
  readonly floorId = signal('');
  readonly reviewer = signal('');
  readonly sidePanel = signal<'doorways' | 'regions' | 'photos'>('doorways');
  /** What a click on the map selects: a room or a doorway. */
  readonly selectMode = signal<'rooms' | 'doorways'>('rooms');
}
