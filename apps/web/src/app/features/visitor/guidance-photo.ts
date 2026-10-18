import { Component, input } from '@angular/core';

/** Filled by the future published route-guidance adapter, never inferred from a photo match. */
export interface GuidancePhoto {
  imageUrl: string;
  alt: string;
  instruction: string;
  direction: 'straight' | 'left' | 'right' | 'back';
}

@Component({
  selector: 'app-guidance-photo',
  template: `<img [src]="photo().imageUrl" [alt]="photo().alt" (error)="failed = true" />
    @if (!failed) {
      <div class="arrow" [class]="'arrow ' + photo().direction" aria-hidden="true">
        <svg viewBox="0 0 100 100"><path d="M50 10 12 48h23v42h30V48h23Z" /></svg>
      </div>
      <p role="status">{{ photo().instruction }}</p>
    } @else {
      <p role="status">This guidance photo could not load. Re-center or try again later.</p>
    }`,
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
        top: 45%;
        width: 70px;
        height: 70px;
        filter: drop-shadow(0 3px 6px #0008);
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
      p {
        position: absolute;
        left: 20px;
        right: 20px;
        bottom: 70px;
        margin: 0;
        background: #fffef5ef;
        color: #233d30;
        border-radius: 16px;
        padding: 14px;
        text-align: center;
        font-size: 14px;
      }
    `,
  ],
})
export class GuidancePhotoView {
  readonly photo = input.required<GuidancePhoto>();
  failed = false;
}
