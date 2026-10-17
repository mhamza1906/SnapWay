import type { VisitorBuilding } from './visitor.models';

/**
 * UI samples, not publications. Building points are from the university's public
 * campus map (category 48600), checked October 17, 2026:
 * https://map.utoronto.ca/?id=1809
 * IA: location 959718 / marker 723740; IC: location 493695 / marker 363654.
 * These are building markers, not surveyed entrances or indoor positions.
 */
export const VISITOR_DEMO_BUILDINGS: readonly VisitorBuilding[] = [
  {
    id: 'demo-utsc-ia',
    slug: 'ia',
    name: 'Sam Ibrahim Building',
    address: '1050 Military Trail, Scarborough, ON M1C 1G9',
    latitude: 43.788609,
    longitude: -79.191116,
    demo: true,
    floors: [
      {
        target_id: 'demo-ia-floor-5',
        name: '5th floor',
        code: '5',
        publication_id: '',
        sequence: 0,
        checkpoints: [],
        destinations: [{ id: 'demo-ia5061', label: 'IA5061', name: 'Health & Wellness Centre' }],
      },
    ],
  },
  {
    id: 'demo-utsc-ic',
    slug: 'ic',
    name: 'Instructional Centre (IC)',
    address: '1095 Military Trail, Scarborough, ON M1C 5J9',
    latitude: 43.786816,
    longitude: -79.189484,
    demo: true,
    buildingDestination: true,
    floors: [],
  },
];

/** Real published buildings take precedence over matching bundled samples. */
export function withDemoBuildings(published: VisitorBuilding[]): VisitorBuilding[] {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const demo = structuredClone(VISITOR_DEMO_BUILDINGS).filter(
    (sample) =>
      !published.some(
        (building) =>
          building.id === sample.id ||
          key(building.slug ?? '') === sample.slug ||
          key(building.name) === key(sample.name) ||
          key(building.name) === key(sample.name.replace(/\s*\(IC\)$/, '')),
      ),
  );
  return [...published, ...demo];
}
