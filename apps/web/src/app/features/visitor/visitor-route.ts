export type RoutePreference = 'any' | 'avoid_stairs' | 'avoid_elevators';

export interface RouteFrame {
  node_id: string;
  revision_id: string;
  label: string;
  floor_name: string;
  image_url: string | null;
  instruction: string;
  next_angle: number | null;
  previous_angle: number | null;
  transition: boolean;
  orientation_known: boolean;
}

export interface PhotoRoute {
  frames: RouteFrame[];
  total_cost: number;
  preference: RoutePreference;
  publication_ids: string[];
}
