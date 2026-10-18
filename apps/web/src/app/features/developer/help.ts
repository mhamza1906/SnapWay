import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
@Component({
  selector: 'app-developer-help',
  imports: [RouterLink],
  styleUrls: ['./workspace.scss', './exports.scss'],
  template: `<section class="page live-page">
    <header class="page-heading page-heading-compact">
      <p>A floor plan, a connected graph, and one clear route forward.</p>
    </header>
    <section class="export-panel">
      <h2>1. Find your building</h2>
      <p>
        Open Explore. Yellow pins mark published buildings; red pins mark your draft floors. Choose
        an existing floor to update it, or select another building to create a floor.
      </p>
      <h2>2. Work in your snapshot</h2>
      <p>
        My maps holds your server-saved work. Your editing snapshot stays fixed while you work, even
        when someone else publishes an update. Upload a plan, place waypoints, connect them and
        attach reference photos.
      </p>
      <h2>3. Finish the floor</h2>
      <p>
        {{
          auth.canAdmin()
            ? 'As an administrator, finishing your map approves and publishes it immediately. Developer contribution lets you compare submissions, request changes, publish updates and archive maps.'
            : 'Submit your completed map for an administrator to review. Until approval, your changes stay unpublished. Requested changes can be continued in a new editing snapshot.'
        }}
      </p>
      <p>
        An approval replaces the currently published version. Archiving removes a floor from Explore
        and destroys every pending edit and submission for that floor.
      </p>
      <h2>4. Export your work</h2>
      <p>
        Settings & exports downloads map JSON, the navigation graph, or an SVG display map. Your
        workspace is stored on the server.
      </p>
      <a class="btn primary" routerLink="/explore">Explore buildings</a>
    </section>
  </section>`,
})
export class DeveloperHelpPage {
  readonly auth = inject(AuthService);
}
