import { Component } from '@angular/core';
@Component({
  selector: 'app-snapway-brand',
  template: `<svg viewBox="0 0 190 44" role="img" aria-label="Snapway">
    <g fill="none" stroke="#192d3d" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 17C6 9 2 24 15 24C31 24 25 38 8 30" />
      <path d="M33 32V16M33 25C37 12 45 13 49 20V32" />
      <path d="M74 31C66 37 56 29 59 21C62 11 74 15 74 24V32" />
      <path d="M84 38V16C100 9 105 26 95 31C90 34 86 30 84 28" />
      <path d="M154 31C146 37 136 29 139 21C142 11 154 15 154 24V32" />
      <path
        stroke="#079bfa"
        d="M104 30C109 27 111 15 116 17C121 19 121 34 127 31C133 28 135 8 143 10"
      />
      <path
        stroke="#079bfa"
        d="M163 16C165 23 167 29 170 30C174 26 178 16 181 9C178 25 175 33 171 36C168 39 165 39 163 37M173 10L181 9L180 17"
      />
    </g>
    <path
      d="M107 29C111 24 112 16 116 19C121 22 122 35 128 29C133 23 135 13 140 11"
      fill="none"
      stroke="#fff"
      stroke-width="1.5"
      stroke-dasharray="3 3"
    />
    <circle cx="66.5" cy="23.5" r="6.4" fill="#079bfa" />
    <path
      d="M66.5 17.1L69 22M72 20.3L68.9 25M72 26.7L66.5 26.3M66.5 29.9L64 25M61 26.7L64.1 22M61 20.3L66.5 20.7"
      fill="none"
      stroke="#fff"
      stroke-width="1"
    />
    <path d="M66.5 20.7L68.9 22.1V24.9L66.5 26.3L64.1 24.9V22.1Z" fill="#fff" />
  </svg>`,
  styles: [
    ':host{display:block;width:190px;max-width:100%}svg{display:block;width:100%;height:auto}',
  ],
})
export class SnapwayBrand {}
