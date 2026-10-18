import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { ClientConfigService } from '../../core/client-config.service';
import { SignInPage } from './sign-in';

describe('Experience sign-in entry', () => {
  it('offers exactly two accessible cards and starts the selected Google flow', async () => {
    const auth = {
      busy: signal(false),
      error: signal(''),
      signIn: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: auth },
        {
          provide: ClientConfigService,
          useValue: { load: async () => ({ auth: { google_enabled: true } }) },
        },
      ],
    });
    const fixture = TestBed.createComponent(SignInPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const cards = fixture.nativeElement.querySelectorAll(
      'button.experience',
    ) as NodeListOf<HTMLButtonElement>;
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute('aria-label')).toContain('Developer');
    expect(cards[1].getAttribute('aria-label')).toContain('Public User');
    cards[1].click();
    await fixture.whenStable();
    expect(auth.signIn).toHaveBeenCalledWith('public', undefined);
    auth.busy.set(true);
    fixture.detectChanges();
    expect(cards[0].disabled && cards[1].disabled).toBe(true);
    fixture.componentInstance.resume({ persisted: true } as PageTransitionEvent);
    fixture.detectChanges();
    expect(cards[0].disabled || cards[1].disabled).toBe(false);
  });
});
