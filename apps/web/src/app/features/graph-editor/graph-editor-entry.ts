import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { GraphEditorPage } from './graph-editor';
import { PhotoWalkEditorPage } from '../photo-walk-editor/photo-walk-editor';

/** Keep saved collection links on the existing phone workflow; use the new workspace editor otherwise. */
@Component({
  selector: 'app-graph-editor-entry',
  imports: [GraphEditorPage, PhotoWalkEditorPage],
  template: `@if (photoMode()) {
      <app-photo-walk-editor />
    } @else {
      <app-graph-editor />
    }`,
})
export class GraphEditorEntry {
  readonly photoMode = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('mode') === 'photos')),
    { initialValue: false },
  );
}
