import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { GraphEditorEntry } from './graph-editor-entry';
import { GraphEditorPage } from './graph-editor';
import { PhotoWalkEditorPage } from '../photo-walk-editor/photo-walk-editor';

@Component({ selector: 'app-graph-editor', template: '<p>Advanced map editor</p>' })
class AdvancedEditorStub {}
@Component({ selector: 'app-photo-walk-editor', template: '<p>Existing phone photo walk</p>' })
class PhotoWalkStub {}

describe('Integrated graph editor selection', () => {
  it('retains photo links and switches reactively without instantiating both editors', async () => {
    const params = new BehaviorSubject(convertToParamMap({ target: 'saved-walk', mode: 'photos' }));
    TestBed.configureTestingModule({
      providers: [{ provide: ActivatedRoute, useValue: { queryParamMap: params } }],
    }).overrideComponent(GraphEditorEntry, {
      remove: { imports: [GraphEditorPage, PhotoWalkEditorPage] },
      add: { imports: [AdvancedEditorStub, PhotoWalkStub] },
    });
    const fixture = TestBed.createComponent(GraphEditorEntry);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-photo-walk-editor')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-graph-editor')).toBeNull();
    params.next(convertToParamMap({ target: 'saved-walk' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-photo-walk-editor')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-graph-editor')).not.toBeNull();
    params.next(convertToParamMap({ target: 'another-walk', mode: 'photos' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Existing phone photo walk');
  });
});
