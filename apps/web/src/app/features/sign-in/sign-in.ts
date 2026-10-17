import { DOCUMENT } from '@angular/common';
import { afterNextRender, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, ExperienceMode } from '../../core/auth.service';
import { ClientConfigService } from '../../core/client-config.service';
import { Icon } from '../../shared/icon';

// Every glyph has four cubic segments, so it can open into a thread without scaling.
const glyphPaths = [
  ['s', 'M22 18C18 13 9 13 7 18C4 23 22 23 22 28C21 34 9 35 5 30C5 30 5 30 5 30', 0, 32],
  ['n', 'M33 32C33 26 33 21 33 16C33 25 37 12 45 16C51 18 49 25 49 32C49 32 49 32 49 32', 32, 57],
  ['a', 'M74 31C66 37 56 29 59 21C62 11 74 15 74 24C74 27 74 29 75 32C75 32 75 32 75 32', 57, 83],
  ['p', 'M84 38C84 30 84 23 84 16C100 9 105 26 95 31C90 34 86 30 84 28C84 28 84 28 84 28', 83, 107],
  [
    'w',
    'M104 30C109 27 111 15 116 17C121 19 121 34 127 31C133 28 135 8 143 10C143 10 143 10 143 10',
    107,
    137,
  ],
  [
    'a',
    'M154 31C146 37 136 29 139 21C142 11 154 15 154 24C154 27 154 29 155 32C155 32 155 32 155 32',
    137,
    179,
  ],
  [
    'y',
    'M163 16C165 23 167 29 170 30C174 26 178 16 181 9C178 25 175 33 171 36C168 39 165 39 163 37',
    163,
    179,
  ],
] as const;

function straightGlyph(start: number, end: number): string {
  const point = (fraction: number) => `${start + (end - start) * fraction} 24`;
  return (
    `M${point(0)}` +
    [0, 1, 2, 3]
      .map(
        (i) => `C${point((i * 3 + 1) / 12)} ${point((i * 3 + 2) / 12)} ${point((i * 3 + 3) / 12)}`,
      )
      .join('')
  );
}

function openingFrames(path: string, target: string): string {
  const points = target.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  let index = 0;
  const opened = path.replace(/-?\d+(?:\.\d+)?/g, (value) => {
    const coordinate = index++;
    return String((Number(value) + points[coordinate]) / 2 - (coordinate % 2 ? 5 : 0));
  });
  return `${path};${opened};${target}`;
}

@Component({
  selector: 'app-sign-in',
  imports: [RouterLink, Icon],
  templateUrl: './sign-in.html',
  styleUrls: ['./sign-in.scss', './sign-in-motion.scss', './sign-in-header.scss'],
  host: { '(window:pageshow)': 'resume($event)' },
})
export class SignInPage {
  readonly brandGlyphs = glyphPaths.map(([letter, path, start, end], index) => ({
    letter,
    path,
    frames: openingFrames(
      path,
      letter === 'y'
        ? 'M169 18C172 20 175 22 179 24C175 26 172 28 169 30C169 30 169 30 169 30C169 30 169 30 169 30'
        : straightGlyph(start, end),
    ),
    begin: `${letter === 'y' ? 1 : 1.75 + (5 - index) * 0.65}s`,
    duration: letter === 'y' ? '.7s' : '.6s',
  }));
  readonly auth = inject(AuthService);
  private readonly document = inject(DOCUMENT);
  private readonly brandMotion = viewChild<ElementRef<SVGSVGElement>>('brandMotion');
  private readonly config = inject(ClientConfigService);
  readonly loading = signal(true);
  readonly enabled = signal(false);
  readonly error = signal('');
  readonly selected = signal<ExperienceMode | null>(null);

  constructor() {
    afterNextRender({
      write: () => {
        if (this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
          return;
        this.brandMotion()
          ?.nativeElement.querySelectorAll<SVGGElement>('[data-glyph]')
          .forEach((group) => {
            const index = Number(group.dataset['glyph']);
            // Indefinite initial begin prevents native SMIL starting before Angular binds
            // the path frames; relative scheduling also works after client-side routing.
            group.querySelectorAll('animate').forEach((animation) => {
              if (typeof animation.beginElementAt === 'function') {
                animation.beginElementAt(Number.parseFloat(this.brandGlyphs[index].begin));
              }
            });
          });
      },
    });
    void this.load();
  }

  resume(event: PageTransitionEvent) {
    if (event.persisted) {
      this.auth.busy.set(false);
      this.selected.set(null);
    }
  }

  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.enabled.set((await this.config.load()).auth.google_enabled);
    } catch {
      this.error.set('We could not connect. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async choose(mode: ExperienceMode) {
    if (this.auth.busy() || this.loading() || !this.enabled()) return;
    this.selected.set(mode);
    await this.auth.signIn(mode);
    if (!this.auth.busy()) this.selected.set(null);
  }
}
