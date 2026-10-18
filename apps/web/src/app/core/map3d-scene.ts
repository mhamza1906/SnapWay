/** Static scene identity must survive different database IDs in each environment. */
export const SAM_IBRAHIM_3D_PATH = '/map3d/sam-ibrahim-level1/3d/index.html';

export function map3dScene(identity: {
  building: string;
  floor: string;
  title: string;
}): string | null {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[·–—_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const building = normalize(identity.building);
  const floor = normalize(identity.floor);
  const title = normalize(identity.title);
  const circulation = /\bcirculation\s+(\d+)\b/.exec(`${floor} ${title}`);
  if (circulation && circulation[1] !== '2') return null;
  return /^sam ibrahim(?: building)?$/.test(building) &&
    /^(?:level\s*|floor\s*)?1(?: circulation 2)?$/.test(floor)
    ? SAM_IBRAHIM_3D_PATH
    : null;
}
