import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PrototypeRepository } from '../../core/prototype.repository';
import { UiService } from '../../core/ui.service';
import { DemoRole } from '../../core/prototype.models';
import { MapCanvas } from '../../shared/map-canvas';
import { Icon } from '../../shared/icon';
@Component({
  selector: 'app-welcome',
  imports: [RouterLink, MapCanvas, Icon],
  template: `<div class="welcome">
    <section class="welcome-story">
      <a class="welcome-brand" routerLink="/overview"><app-icon name="route" />snapway.</a>
      <div class="story">
        <span class="subtle-label">FIND YOUR WAY, INSIDE.</span>
        <h1>Every space has<br />a way through.</h1>
        <p>
          Turn local knowledge into clear directions.<br />One room, one floor, one shared map at a
          time.
        </p>
        <div class="welcome-map">
          @if (repo.targets()[0].published; as map) {
            <app-map-canvas
              [document]="map.document"
              [route]="['entrance', 'hall-west', 'hall-centre', 'node-r102']"
              [position]="'hall-west'"
              [compact]="true"
            />
          }
        </div>
      </div>
      <small>A collaborative indoor navigation prototype</small>
    </section>
    <section class="welcome-form">
      <span class="badge orange">Interactive prototype</span>
      <h2>Where would you like to start?</h2>
      <p>Choose an experience to explore. Your work stays in this browser.</p>
      <button class="experience" (click)="enter('volunteer')">
        <span class="experience-icon"><app-icon name="edit" /></span
        ><span
          ><strong>Build a clearer map</strong
          ><small>Contribute plans, room details and reference photos.</small></span
        ><app-icon name="arrow-right" /></button
      ><button class="experience" (click)="enter('admin')">
        <span class="experience-icon"><app-icon name="review" /></span
        ><span
          ><strong>Manage the workspace</strong
          ><small>Create targets, review contributions and publish.</small></span
        ><app-icon name="arrow-right" /></button
      ><a class="experience" routerLink="/navigate"
        ><span class="experience-icon"><app-icon name="compass" /></span
        ><span
          ><strong>Find a place</strong
          ><small>Try visitor navigation on a published map.</small></span
        ><app-icon name="arrow-right"
      /></a>
      <p class="demo-note">
        Demo access · no account or password needed.<br />Authentication and device services will be
        connected later.
      </p>
      <a class="link" routerLink="/help"
        >New to SnapWay? Follow the walkthrough <app-icon name="arrow-right"
      /></a>
    </section>
  </div>`,
  styles: [
    `
      :host {
        display: block;
      }
      .welcome {
        min-height: 100dvh;
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .welcome-story {
        background: #eaf0e4;
        padding: 35px 50px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .welcome-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 27px;
        font-weight: 750;
        letter-spacing: -1.5px;
      }
      .welcome-brand app-icon {
        color: var(--accent);
        width: 30px;
        height: 30px;
      }
      .story {
        margin: auto 0;
        padding: 50px 0 15px;
      }
      .story h1 {
        font-size: 52px;
        font-weight: 550;
        letter-spacing: -2.5px;
        line-height: 1.1;
        margin: 20px 0;
      }
      .story p {
        color: #79866b;
        font-size: 14px;
        line-height: 1.8;
      }
      .welcome-map {
        margin-top: 25px;
        transform: rotate(-5deg);
        background: #fff;
        border: 1px solid #d3dcc9;
        border-radius: 14px;
        box-shadow: 10px 15px 0 #d9e1d1;
        overflow: hidden;
      }
      .welcome-story > small {
        color: #8b987f;
        font-size: 10px;
        margin-top: 30px;
      }
      .welcome-form {
        align-self: center;
        max-width: 530px;
        padding: 50px;
        margin: auto;
      }
      .welcome-form h2 {
        font-size: 29px;
        letter-spacing: -1px;
        line-height: 1.25;
        margin: 20px 0 12px;
      }
      .welcome-form > p {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.7;
        margin-bottom: 28px;
      }
      .experience {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 15px;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 20px 16px;
        background: #fff;
        text-align: left;
        cursor: pointer;
        margin: 12px 0;
        transition:
          transform 0.2s,
          border-color 0.2s;
        color: var(--ink);
      }
      .experience:hover {
        border-color: var(--accent);
        transform: translateX(4px);
      }
      .experience-icon {
        padding: 10px;
        border-radius: 9px;
        background: #f4f3ed;
        color: #89947a;
      }
      .experience strong {
        display: block;
        font-size: 13px;
      }
      .experience small {
        display: block;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.6;
        margin-top: 6px;
      }
      .experience > app-icon {
        margin-left: auto;
        width: 16px;
        flex-shrink: 0;
      }
      .welcome-form > .demo-note {
        font-size: 10px;
        text-align: center;
        margin: 25px 0;
        line-height: 1.8;
      }
      .link {
        font-size: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
      }
      .link app-icon {
        width: 14px;
      }
      @media (max-width: 900px) {
        .welcome-story {
          padding: 30px;
        }
        .story h1 {
          font-size: 42px;
        }
        .welcome-form {
          padding: 32px;
        }
      }
      @media (max-width: 650px) {
        .welcome {
          grid-template-columns: 1fr;
        }
        .welcome-story {
          padding: 24px;
        }
        .story {
          padding: 30px 0 0;
        }
        .story h1 {
          font-size: 36px;
        }
        .welcome-map,
        .welcome-story > small {
          display: none;
        }
        .story p {
          font-size: 12px;
        }
        .welcome-form {
          padding: 32px 24px;
        }
        .welcome-form h2 {
          font-size: 25px;
        }
      }
    `,
  ],
})
export class WelcomePage {
  readonly repo = inject(PrototypeRepository);
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  enter(role: DemoRole) {
    this.ui.run(() => {
      this.repo.setRole(role);
      void this.router.navigate(['/overview']);
    });
  }
}
