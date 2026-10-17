import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-help',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page help-page">
      <header class="page-heading">
        <div>
          <p class="eyebrow">A GOOD PLACE TO START</p>
          <h1>Explore the prototype</h1>
          <p>Three journeys. One shared map. Try the complete loop.</p>
        </div>
        <a class="btn secondary" routerLink="/settings"
          ><app-icon name="settings" /> Demo settings</a
        >
      </header>
      <div class="notice info">
        <app-icon name="help" /><span
          >The sample buildings are fictional. Your edits and review decisions are saved locally;
          AI, camera and positioning responses are simulated.</span
        >
      </div>
      <div class="grid-3 journey-grid">
        <article class="panel journey">
          <div class="journey-icon"><app-icon name="edit" /></div>
          <span class="eyebrow">01 / CONTRIBUTOR</span>
          <h2>Make a map better</h2>
          <p>Start from a publication and turn your observations into a reviewable contribution.</p>
          <ol>
            <li>Open Innovation Centre and inspect its published map.</li>
            <li>Open the example draft, select a room and change its name.</li>
            <li>Add a text label or map pin, then try a sample image and an AI suggestion.</li>
            <li>
              Save your draft, refresh to verify it persists, and submit with a change summary.
            </li>
          </ol>
          <div class="journey-actions">
            <a class="btn primary" routerLink="/editor/innovation-draft"
              >Open example draft <app-icon name="arrow-right" /></a
            ><a class="link" routerLink="/targets/innovation">Inspect mapping target</a>
          </div>
        </article>
        <article class="panel journey">
          <div class="journey-icon blue"><app-icon name="review" /></div>
          <span class="eyebrow">02 / ADMINISTRATOR</span>
          <h2>Review with confidence</h2>
          <p>Compare the contribution, leave useful feedback and publish a coherent revision.</p>
          <ol>
            <li>Use the administrator role in Settings.</li>
            <li>Open the example review and compare its lift-access pin with the published map.</li>
            <li>Request changes with feedback, or publish when the map is ready.</li>
            <li>Return to the target and verify the publication version and activity update.</li>
          </ol>
          <div class="journey-actions">
            <a class="btn secondary" routerLink="/review/innovation-review"
              >Open example review <app-icon name="arrow-right" /></a
            ><a class="link" routerLink="/activity">Inspect recent activity</a>
          </div>
        </article>
        <article class="panel journey">
          <div class="journey-icon green"><app-icon name="compass" /></div>
          <span class="eyebrow">03 / VISITOR</span>
          <h2>Find your next room</h2>
          <p>
            Explore a published floor, preview capture outcomes and follow the route one step at a
            time.
          </p>
          <ol>
            <li>Open visitor navigation and choose Innovation Centre.</li>
            <li>Select a destination such as Robotics Lab, and choose your starting point.</li>
            <li>Try simulated capture, confirm the result and start guidance.</li>
            <li>
              Advance the route to arrival; repeat with step-free routing or an ambiguous capture.
            </li>
          </ol>
          <div class="journey-actions">
            <a class="btn secondary" routerLink="/navigate"
              >Try visitor navigation <app-icon name="arrow-right" /></a
            ><span class="subtle-label">Desktop and mobile preview</span>
          </div>
        </article>
      </div>
      <section class="panel behavior-panel" aria-labelledby="behavior-title">
        <div class="panel-heading"><h2 id="behavior-title">What you can test today</h2></div>
        <div class="panel-body grid-2">
          <div>
            <h3><app-icon name="check" /> Working locally</h3>
            <p>
              Page navigation, map edits, image uploads, draft saves, role restrictions, review
              decisions, version conflicts, route calculation, export and import.
            </p>
          </div>
          <div>
            <h3><app-icon name="sparkles" /> Simulated for exploration</h3>
            <p>
              AI interpretation and replies, camera and permission states, Android lifecycle events,
              indoor position and live guidance updates. These use controlled demo responses.
            </p>
          </div>
        </div>
      </section>
      <section class="questions" aria-labelledby="questions-title">
        <h2 id="questions-title">When something needs another look</h2>
        <details>
          <summary>My example draft is stale or already submitted</summary>
          <p>
            A publication creates a new revision. Request changes for a submitted contribution,
            compare the latest map, and explicitly reconcile your draft before resubmitting. You can
            also create a new contribution from the current publication.
          </p>
        </details>
        <details>
          <summary>My changes disappeared after switching browser or address</summary>
          <p>
            Prototype data belongs to the current browser and site address. Use
            <a routerLink="/settings" class="link">Settings → Export data</a> before moving, then
            import the JSON copy in the other browser.
          </p>
        </details>
        <details>
          <summary>How do I repeat the original three journeys?</summary>
          <p>
            Export any work you need, then use
            <a routerLink="/settings" class="link">Settings → Reset demo</a>. This restores the
            example draft, review and published maps, with administrator access.
          </p>
        </details>
        <details>
          <summary>What should I include in feedback?</summary>
          <p>
            Record the page, role, target, steps you took, expected behavior and what happened.
            Include a screenshot or exported JSON when useful, and note whether you were testing a
            simulated result.
          </p>
        </details>
      </section>
    </main>
  `,
  styles: `
    .help-page {
      max-width: 1320px;
    }
    .journey-grid {
      margin-top: 26px;
    }
    .journey {
      padding: 25px;
      display: flex;
      flex-direction: column;
    }
    .journey-icon {
      width: 42px;
      height: 42px;
      background: #fff0e7;
      color: var(--accent);
      display: grid;
      place-items: center;
      border-radius: 11px;
      margin-bottom: 23px;
    }
    .journey-icon.blue {
      background: #eaf0fc;
      color: var(--blue);
    }
    .journey-icon.green {
      background: #eaf3ed;
      color: var(--green);
    }
    .journey .eyebrow {
      font-size: 10px;
      letter-spacing: 1px;
    }
    .journey h2 {
      font-size: 19px;
      margin-bottom: 11px;
    }
    .journey p {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 17px;
    }
    .journey ol {
      padding-left: 18px;
      margin: 0 0 25px;
      font-size: 12px;
      line-height: 1.8;
      color: #59666b;
    }
    .journey li {
      padding: 0 0 11px 3px;
    }
    .journey li::marker {
      color: var(--accent);
      font-size: 11px;
    }
    .journey-actions {
      margin-top: auto;
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      gap: 16px;
    }
    .behavior-panel {
      margin-top: 27px;
    }
    .behavior-panel h3 {
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .behavior-panel h3 app-icon {
      width: 17px;
      height: 17px;
      color: var(--green);
    }
    .behavior-panel p {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 0;
    }
    .questions {
      margin-top: 34px;
    }
    .questions h2 {
      margin-bottom: 19px;
    }
    .questions details {
      border-bottom: 1px solid var(--line);
      padding: 18px 0;
    }
    .questions summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .questions details p {
      font-size: 12px;
      color: var(--muted);
      margin: 15px 0 0;
      max-width: 850px;
    }
    .notice app-icon {
      width: 17px;
      margin-top: 1px;
    }
    @media (max-width: 1100px) {
      .journey-grid {
        grid-template-columns: 1fr;
      }
      .journey {
        padding: 24px;
      }
      .journey-icon {
        margin-bottom: 17px;
      }
      .journey ol {
        margin-bottom: 12px;
      }
      .journey-actions {
        flex-direction: row;
        align-items: center;
        flex-wrap: wrap;
      }
    }
  `,
})
export class HelpPage {}
