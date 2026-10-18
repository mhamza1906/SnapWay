export interface VisitorRoom {
  id: string;
  label: string;
  name: string;
}

export interface VisitorBuilding {
  id: string;
  name: string;
  slug?: string;
  address: string;
  latitude: number;
  longitude: number;
  floors: {
    target_id: string;
    name: string;
    code: string;
    publication_id: string | null;
    sequence: number | null;
    checkpoints?: { id: string; label: string }[];
    destinations?: VisitorRoom[];
  }[];
}

export interface DestinationOption {
  key: string;
  building: VisitorBuilding;
  room?: VisitorRoom;
  floor?: VisitorBuilding['floors'][number];
}

export function searchDestinations(
  buildings: VisitorBuilding[],
  query: string,
  selected: VisitorBuilding | null,
): DestinationOption[] {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = key(query);
  const matches: DestinationOption[] = [];
  for (const building of buildings) {
    if (selected && building.id !== selected.id) continue;
    if (
      !selected &&
      key(`${building.slug ?? ''} ${building.name} ${building.address}`).includes(wanted)
    )
      matches.push({ key: building.id, building });
    for (const floor of building.floors) {
      for (const room of floor.destinations ?? []) {
        const labels = [room.label, room.name, `${building.slug ?? ''}${room.label}`];
        if (labels.some((label) => key(label).includes(wanted)))
          matches.push({ key: `${floor.publication_id}:${room.id}`, building, floor, room });
      }
    }
  }
  return matches
    .sort(
      (a, b) =>
        Number(key(b.room?.label ?? '') === wanted) - Number(key(a.room?.label ?? '') === wanted),
    )
    .slice(0, 12);
}
