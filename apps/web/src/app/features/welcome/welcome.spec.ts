import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { WelcomePage } from './welcome';

describe('Saved developer link after a public sign-in', () => {
  it('asks for an explicit mode switch and restores the saved collection target', async () => {
    const developer = signal(false);
    const auth = {
      name: () => 'Mapper',
      role: () => (developer() ? 'Developer' : 'Public User'),
      isDeveloper: developer,
      landingPath: computed(() => (developer() ? '/overview' : '/public')),
      busy: () => false,
      error: () => '',
      switchMode: vi.fn(async () => {
        developer.set(true);
        return true;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: auth },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap({
                returnUrl: '/graph-editor?target=walk&mode=photos',
              }),
            },
          },
        },
      ],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(WelcomePage);
    expect(fixture.componentInstance.destination()).toBe('/public');
    await fixture.componentInstance.switchMode();
    expect(auth.switchMode).toHaveBeenCalledWith('developer');
    expect(navigate).toHaveBeenCalledWith('/graph-editor?target=walk&mode=photos');
  });
});
