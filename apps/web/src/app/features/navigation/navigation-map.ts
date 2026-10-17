import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { MapDocument } from '../../core/prototype.models';
import { MapCanvas } from '../../shared/map-canvas';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-navigation-map',
  imports: [MapCanvas, Icon],
  templateUrl: './navigation-map.html',
  styleUrl: './navigation-map.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavigationMap {
  readonly document = input.required<MapDocument>();
  readonly name = input('');
  readonly floor = input('');
  readonly selected = input('');
  readonly route = input<string[]>([]);
  readonly position = input('');
  readonly phase = input<'planning' | 'guiding' | 'arrived'>('planning');
  readonly instruction = input('');
  readonly guideAngle = input(-90);
  readonly paused = input(false);
  readonly view = signal<'map' | 'guided'>('map');
  readonly objectSelected = output<string>();
  readonly advanced = output<void>();
}
