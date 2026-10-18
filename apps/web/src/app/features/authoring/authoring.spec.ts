import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthoringPage } from './authoring';

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('map setup page', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AuthoringPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function start() {
    const fixture = TestBed.createComponent(AuthoringPage);
    fixture.detectChanges();
    http.expectOne('/api/maps/workspace/').flush({ maps: [] });
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  it('shows search/create modes and requires building + floor before upload', async () => {
    const fixture = await start();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Search an existing building');
    expect(text).toContain('Create a new building');
    expect(text).toContain('Upload floor plan');
    const page = fixture.componentInstance;
    expect(page.canUpload()).toBe(false);
    page.buildingName.set('Instructional Centre');
    page.floorCode.set('4');
    expect(page.canUpload()).toBe(true);
  });

  it('creates a map then opens the editor without an upload', async () => {
    const fixture = await start();
    const page = fixture.componentInstance;
    page.mode.set('new');
    page.buildingName.set('Instructional Centre');
    page.floorCode.set('4');
    page.latitude.set('43.548');
    page.longitude.set('-79.663');
    const open = page.openEditor();
    const create = http.expectOne('/api/maps/workspace/');
    expect(create.request.method).toBe('POST');
    expect(create.request.body.building_name).toBe('Instructional Centre');
    create.flush({
      id: 'm1',
      target_id: 't1',
      contribution_id: null,
      revision_id: null,
      title: 'Instructional Centre',
      building: 'Instructional Centre',
      floor: '4',
      floor_code: '4',
      status: 'draft',
      kind: 'manual',
      author: 'a',
      updated_at: '',
      sequence: null,
      preview_url: null,
      can_admin: true,
    });
    await open;
    await flush();
  });
});
