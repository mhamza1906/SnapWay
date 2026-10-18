import { Component, input, output, signal, effect } from '@angular/core';

/** Published route frame. Image browsing never updates the confirmed physical location. */
export interface GuidancePhoto {
  imageUrl: string | null;
  alt: string;
  instruction: string;
  direction: 'straight' | 'left' | 'right' | 'back';
  nextAngle?: number | null;
  previousAngle?: number | null;
  hasNext?: boolean;
  hasPrevious?: boolean;
  transition?: boolean;
  step?: number;
  count?: number;
}

@Component({
  selector: 'app-guidance-photo',
  template: `@if (photo().imageUrl && !failed()) {
      <img [src]="photo().imageUrl" [alt]="photo().alt" (error)="failed.set(true)" />
    } @else {
      <div class="missing" role="status">
        <strong>{{ photo().alt }}</strong>
        <span>{{
          failed()
            ? 'This reference photo could not load.'
            : 'No reviewed reference photo is available here.'
        }}</span>
      </div>
    }
    @if (photo().hasNext && photo().imageUrl && !failed() && photo().nextAngle != null) {
      <button
        class="arrow next"
        [style.transform]="'rotate(' + photo().nextAngle + 'deg)'"
        aria-label="Preview next checkpoint"
        (click)="next.emit()"
      >
        <svg viewBox="0 0 100 100"><path d="M50 10 12 48h23v42h30V48h23Z" /></svg>
      </button>
    } @else if (photo().hasNext === undefined && photo().imageUrl && !failed()) {
      <div [class]="'arrow ' + photo().direction" aria-hidden="true">
        <svg viewBox="0 0 100 100"><path d="M50 10 12 48h23v42h30V48h23Z" /></svg>
      </div>
    }
    @if (photo().hasPrevious && photo().imageUrl && !failed() && photo().previousAngle != null) {
      <button
        class="arrow previous"
        [style.transform]="'rotate(' + photo().previousAngle + 'deg)'"
        aria-label="Preview previous checkpoint"
        (click)="previous.emit()"
      >
        <svg viewBox="0 0 100 100"><path d="M50 10 12 48h23v42h30V48h23Z" /></svg>
      </button>
    }
    <div class="caption">
      @if (photo().count) {
        <span>Route preview · {{ photo().step }} / {{ photo().count }}</span>
      }
      <p role="status">{{ photo().instruction }}</p>
      @if (photo().hasNext && photo().nextAngle == null && !photo().transition) {
        <small>Photo direction is unavailable. Check the signs around you.</small>
      }
      @if (photo().hasNext !== undefined) {
        <nav aria-label="Route photo controls">
          <button [disabled]="!photo().hasPrevious" (click)="previous.emit()">
            ← Previous photo
          </button>
          <button [disabled]="!photo().hasNext" (click)="next.emit()">Next photo →</button>
        </nav>
      }
    </div>`,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        display: block;
      }
      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .arrow {
        position: absolute;
        left: calc(50% - 35px);
        top: 30%;
        width: 70px;
        height: 70px;
        filter: drop-shadow(0 3px 6px #0008);
        padding: 0;
        border: 0;
        background: transparent;
        cursor: pointer;
      }
      .previous {
        left: calc(25% - 35px);
        top: 30%;
      }
      .previous svg {
        fill: #fffef5;
      }
      button:hover {
        filter: brightness(1.12) drop-shadow(0 3px 6px #0008);
      }
      button:focus-visible {
        outline: 3px solid #315b46;
        outline-offset: 5px;
      }
      .missing {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        gap: 12px;
        padding: 28px 28px 220px;
        text-align: center;
        background: #e8ede4;
        color: #233d30;
      }
      svg {
        width: 100%;
        height: 100%;
        fill: #e1f38c;
        stroke: #315b46;
        stroke-width: 2;
      }
      .left {
        transform: rotate(-90deg);
      }
      .right {
        transform: rotate(90deg);
      }
      .back {
        transform: rotate(180deg);
      }
      .caption {
        position: absolute;
        left: 20px;
        right: 20px;
        bottom: 80px;
        margin: 0;
        background: #fffef5ef;
        color: #233d30;
        border-radius: 16px;
        padding: 14px;
        text-align: center;
        font-size: 14px;
      }
      p {
        margin: 8px 0;
      }
      small {
        display: block;
        margin: 8px 0;
      }
      nav {
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }
      nav button {
        min-height: 44px;
        border: 1px solid #315b46;
        border-radius: 10px;
        padding: 8px 12px;
        background: #fffef5;
        color: #233d30;
        cursor: pointer;
      }
      nav button:disabled {
        opacity: 0.45;
        cursor: default;
      }
    `,
  ],
})
export class GuidancePhotoView {
  readonly photo = input.required<GuidancePhoto>();
  readonly next = output<void>();
  readonly previous = output<void>();
  readonly failed = signal(false);
  constructor() {
    effect(() => {
      this.photo();
      this.failed.set(false);
    });
  }
}
