import { Component, input } from '@angular/core';
const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
  layers: 'm12 3 10 6-10 6L2 9z M2 13l10 6 10-6 M2 17l10 6 10-6',
  plus: 'M12 5v14 M5 12h14',
  close: 'm6 6 12 12 M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  'arrow-right': 'M4 12h16 m-6-6 6 6-6 6',
  'arrow-left': 'M20 12H4 m6-6-6 6 6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  search: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  upload: 'M12 16V3 m-5 5 5-5 5 5 M4 15v6h16v-6',
  download: 'M12 3v13 m-5-5 5 5 5-5 M4 16v5h16v-5',
  pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0 M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  route: 'M5 5h11a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8h11 M3 3h4v4H3z M17 19h4v4h-4z',
  image: 'M3 3h18v18H3z m0 14 6-6 5 5 3-3 4 4 M9 7h.01',
  sparkles: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z M3 2v4 M1 4h4',
  settings:
    'm9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  eye: 'M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  trash: 'M3 6h18 M8 6V3h8v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  edit: 'm15 3 6 6-12 12H3v-6z M12 6l6 6',
  undo: 'M3 10h10a7 7 0 0 1 7 7 M3 10l5-5 M3 10l5 5',
  redo: 'M21 10H11a7 7 0 0 0-7 7 M21 10l-5-5 M21 10l-5 5',
  'zoom-in': 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M7 10h6 M10 7v6',
  'zoom-out': 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M7 10h6',
  camera: 'M3 6h5l2-3h4l2 3h5v15H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  compass: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 m-6-6-3 7-7 3 3-7z',
  location:
    'M12 2v4 M12 18v4 M2 12h4 M18 12h4 M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  accessibility: 'M14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M4 8l8 2 8-2 M12 10v5 m-5 7 5-7 5 7',
  review: 'M9 3h6v4H9z M9 5H5v16h14V5h-4 M8 14l3 3 5-6',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 6v6l4 3',
  arrow: 'm5 19 14-14 M5 5h14v14',
  help: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01',
  building: 'M5 22V3h14v19 M2 22h20 M9 7h1 M14 7h1 M9 11h1 M14 11h1 M9 15h1 M14 15h1 M10 22v-4h4v4',
  logout: 'M9 3H3v18h6 M8 12h13 m-5-5 5 5-5 5',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  bell: 'M5 17V9a7 7 0 0 1 14 0v8l2 2H3z M9 22h6',
  archive: 'M3 3h18v5H3z M5 8v13h14V8 M9 12h6',
};
@Component({
  selector: 'app-icon',
  template:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path()" /></svg>',
  styles: [
    ':host{display:inline-flex;width:20px;height:20px;flex-shrink:0}svg{width:100%;height:100%}',
  ],
})
export class Icon {
  readonly name = input('map');
  path() {
    return paths[this.name()] ?? paths['map'];
  }
}
