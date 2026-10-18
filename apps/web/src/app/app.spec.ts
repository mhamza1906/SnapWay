import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { PROTOTYPE_STORAGE } from './core/prototype.repository';
import { AuthService } from './core/auth.service';

@Component({ template: '<p>Route content</p>' })
class RouteContent {}

describe('Workspace shell routing', () => {
  it('keeps welcome and navigation full screen when query strings or capture fragments are present', async () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          { path: 'welcome', component: RouteContent },
          { path: 'navigate', component: RouteContent },
          { path: 'targets', component: RouteContent },
        ]),
        { provide: PROTOTYPE_STORAGE, useValue: null },
        {
          provide: AuthService,
          useValue: {
            refresh: async () => ({ authenticated: true }),
            initials: () => 'TS',
            name: () => 'Test',
            session: () => ({ email: 'test@example.com' }),
            role: () => 'No map membership',
            isDeveloper: () => true,
            canAdmin: () => false,
            busy: () => false,
            error: () => '',
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await fixture.whenStable();
    await router.navigateByUrl('/welcome#figmacapture=test');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.sidebar')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Route content');
    await router.navigateByUrl('/navigate?target=innovation#capture');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.sidebar')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Back to workspace');
    await router.navigateByUrl('/targets?status=open#capture');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.skip-link').getAttribute('href')).toBe(
      '/targets?status=open#main-content',
    );
    expect(fixture.nativeElement.querySelector('.sidebar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.header-title').textContent.trim()).toBe('My maps');
  });
});
