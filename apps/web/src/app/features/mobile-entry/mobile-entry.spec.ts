import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MobileEntry } from './mobile-entry';
import { mobileRoutes } from '../../mobile.routes';
import { NATIVE_API_ORIGIN } from '../../core/native-api.interceptor';

describe('Shared Android and iOS entry', () => {
  it('offers native visitor navigation and the existing HTTPS developer website', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(mobileRoutes)] });
    const fixture = TestBed.createComponent(MobileEntry);
    await fixture.whenStable();
    const choices = fixture.nativeElement.querySelectorAll(
      'nav a',
    ) as NodeListOf<HTMLAnchorElement>;
    expect(choices.length).toBe(2);
    expect(choices[0].getAttribute('href')).toBe('/public');
    expect(choices[0].textContent).toContain('Find my way');
    expect(choices[1].getAttribute('href')).toBe(
      `${NATIVE_API_ORIGIN}/sign-in?returnUrl=%2Fauthoring`,
    );
    expect(choices[1].rel).toContain('external');
    expect(choices[1].textContent).toContain('Open in browser');
  });

  it('keeps the native visitor build free of contributor routes', () => {
    expect(mobileRoutes.find((route) => route.path === '')?.pathMatch).toBe('full');
    expect(mobileRoutes.find((route) => route.path === 'public')?.data?.['contributor']).toBe(
      false,
    );
    for (const path of ['authoring', 'graph-editor', 'capture', 'sign-in']) {
      expect(mobileRoutes.find((route) => route.path === path)).toBeUndefined();
    }
  });
});
