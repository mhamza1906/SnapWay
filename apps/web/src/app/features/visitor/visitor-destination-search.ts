import { Component, computed, effect, input, output, signal } from '@angular/core';

export interface DestinationSuggestion {
  key: string;
  label: string;
  detail: string;
  searchText: string;
}

@Component({
  selector: 'app-destination-search',
  host: { '[class.is-open]': 'open()' },
  template: `
    <input
      [id]="fieldId()"
      [attr.aria-label]="label()"
      role="combobox"
      aria-autocomplete="list"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="fieldId() + '-options'"
      [attr.aria-activedescendant]="
        open() && highlighted() >= 0 && matches().length
          ? fieldId() + '-option-' + highlighted()
          : null
      "
      [placeholder]="placeholder()"
      [disabled]="disabled()"
      [value]="query() ?? selectedLabel()"
      (input)="search($event)"
      (focus)="show()"
      (blur)="open.set(false)"
      (keydown)="keydown($event)"
      autocomplete="off"
      spellcheck="false"
      type="text"
    />
    @if (open()) {
      <div
        class="suggestions"
        role="listbox"
        [id]="fieldId() + '-options'"
        [attr.aria-label]="label() + ' suggestions'"
      >
        @for (option of matches(); track option.key; let index = $index) {
          <button
            type="button"
            role="option"
            tabindex="-1"
            [id]="fieldId() + '-option-' + index"
            [attr.aria-selected]="highlighted() === index"
            [class.highlighted]="highlighted() === index"
            (pointerdown)="$event.preventDefault()"
            (click)="choose(option)"
          >
            <strong>{{ option.label }}</strong>
            <small>{{ option.detail }}</small>
          </button>
        } @empty {
          <p role="status">No matches found.</p>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        min-width: 0;
      }
      :host.is-open {
        z-index: 5;
      }
      input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 44px;
        min-height: 44px;
        padding: 18px 2px 5px;
        border: 0;
        border-bottom: 1px solid #a7b5a0;
        border-radius: 0;
        background: transparent;
        color: #233d30;
        font: inherit;
        font-size: 14px;
        line-height: 20px;
        text-overflow: ellipsis;
      }
      input::placeholder {
        color: #8a9584;
      }
      input:hover:enabled {
        border-bottom-color: #5f7a55;
      }
      input:focus-visible {
        outline: none;
        border-bottom-color: #315b46;
        box-shadow: 0 1px 0 #315b46;
      }
      input:disabled {
        border-bottom-color: #d7dfd3;
        color: #8a9584;
      }
      .suggestions {
        position: absolute;
        left: 0;
        right: 0;
        top: calc(100% + 6px);
        max-height: 260px;
        overflow: auto;
        padding: 4px;
        border: 1px solid #d7dfd3;
        border-radius: 14px;
        background: white;
        box-shadow: 0 8px 20px #233d3018;
      }
      button {
        display: block;
        width: 100%;
        min-height: 48px;
        padding: 10px 8px;
        border: 0;
        border-radius: 10px;
        background: white;
        color: #233d30;
        text-align: left;
        overflow-wrap: anywhere;
        cursor: pointer;
      }
      button:hover,
      button.highlighted {
        background: #eef2e8;
      }
      strong,
      small {
        display: block;
      }
      strong {
        font-size: 13px;
        font-weight: 550;
      }
      small,
      p {
        font-size: 11px;
        color: #7b8875;
      }
      small {
        margin-top: 4px;
      }
      p {
        padding: 8px;
      }
    `,
  ],
})
export class DestinationSearch {
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  readonly placeholder = input.required<string>();
  readonly options = input.required<DestinationSuggestion[]>();
  readonly selectedKey = input('');
  readonly disabled = input(false);
  readonly selected = output<string>();
  readonly query = signal<string | null>(null);
  readonly open = signal(false);
  readonly highlighted = signal(-1);
  readonly selectedLabel = computed(
    () => this.options().find((option) => option.key === this.selectedKey())?.label ?? '',
  );
  readonly matches = computed(() => {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const query = normalize(this.query() ?? '');
    return this.options().filter((option) => normalize(option.searchText).includes(query));
  });

  constructor() {
    effect(() => {
      if (this.disabled()) {
        this.query.set(null);
        this.open.set(false);
      }
      if (this.selectedKey()) this.query.set(null);
    });
  }
  show() {
    this.open.set(true);
    this.highlighted.set(-1);
  }
  search(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
    this.open.set(true);
    this.highlighted.set(-1);
    if (this.selectedKey()) this.selected.emit('');
  }
  choose(option: DestinationSuggestion) {
    this.query.set(null);
    this.open.set(false);
    this.selected.emit(option.key);
  }
  keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') this.open.set(false);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.open.set(true);
      const count = this.matches().length;
      const index = this.highlighted();
      this.highlighted.set(
        count
          ? index < 0
            ? event.key === 'ArrowDown'
              ? 0
              : count - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
          : -1,
      );
      document
        .getElementById(`${this.fieldId()}-option-${this.highlighted()}`)
        ?.scrollIntoView?.({ block: 'nearest' });
    }
    if (event.key === 'Enter' && this.open() && !event.isComposing) {
      const option = this.matches()[Math.max(0, this.highlighted())];
      if (option) {
        event.preventDefault();
        this.choose(option);
      }
    }
  }
}
