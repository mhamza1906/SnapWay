// Project-only expansion of existing capture walks. Existing nodes are immutable.
// Add stops on existing edges at the largest gap measured along the walking graph.
export const DENSITY_PROFILE = 'adaptive-40-v1';

const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const orderOf = node => Number(/^Point (\d+)$/.exec(node.label)?.[1] || 0);

function distancesToPhotos(walk) {
  const distances = walk.nodes.map(node => orderOf(node) ? 0 : Infinity);
  const visited = new Set();
  const adjacency = walk.nodes.map(() => []);
  for (const edge of walk.edges) {
    const weight = length(walk.nodes[edge.from], walk.nodes[edge.to]);
    adjacency[edge.from].push([edge.to, weight]);
    adjacency[edge.to].push([edge.from, weight]);
  }
  for (let n = 0; n < walk.nodes.length; n++) {
    let at = -1;
    distances.forEach((value, index) => {
      if (!visited.has(index) && (at < 0 || value < distances[at])) at = index;
    });
    if (at < 0 || !Number.isFinite(distances[at])) break;
    visited.add(at);
    for (const [other, weight] of adjacency[at]) {
      distances[other] = Math.min(distances[other], distances[at] + weight);
    }
  }
  return distances;
}

export function densifyPhotoWalk(input, { reservedOrders = [] } = {}) {
  const walk = structuredClone(input);
  if (walk.densityProfile?.id === DENSITY_PROFILE) return walk;
  const before = walk.nodes.filter(orderOf).length;
  if (before !== walk.points || before > 40) throw new Error('Invalid source point count.');
  // Areas that previously reached the 30-stop limit now use the new 40-stop cap.
  // Smaller walks expand modestly; tiny one-stop areas stay unchanged.
  const originalBudget = before + reservedOrders.length;
  const target = before < 2 ? before : originalBudget >= 30 ? 40 : Math.min(40, Math.ceil(before * 1.15));
  const additions = [];
  let next = Math.max(0, ...walk.nodes.map(orderOf), ...reservedOrders) + 1;
  const padding = Math.max(1, Math.hypot(walk.width, walk.height) * 0.001);
  while (walk.points < target) {
    const distances = distancesToPhotos(walk);
    let best = null;
    walk.edges.forEach((edge, edgeIndex) => {
      const a = walk.nodes[edge.from], b = walk.nodes[edge.to], total = length(a, b);
      if (total < 2 * padding || !Number.isFinite(distances[edge.from] + distances[edge.to])) return;
      const along = Math.max(padding, Math.min(total - padding, (distances[edge.to] + total - distances[edge.from]) / 2));
      const fraction = along / total;
      const x = Math.round((a.x + (b.x - a.x) * fraction) * 1e6) / 1e6;
      const y = Math.round((a.y + (b.y - a.y) * fraction) * 1e6) / 1e6;
      const point = { x, y };
      if (walk.nodes.some(node => length(node, point) < padding - 1e-5)) return;
      const separation = Math.min(distances[edge.from] + along, distances[edge.to] + total - along);
      if (separation < padding) return;
      if (!best || separation > best.separation + 1e-6) best = { edgeIndex, separation, point };
    });
    if (!best) break;
    const edge = walk.edges[best.edgeIndex];
    const added = walk.nodes.length;
    walk.nodes.push({ ...best.point, label: `Point ${next}`, kind: 'checkpoint', photoOrder: next });
    walk.edges.splice(best.edgeIndex, 1, { ...edge, to: added }, { ...edge, from: added });
    additions.push(next++);
    walk.points++;
  }
  if (additions.length) {
    const oldSource = walk.source;
    walk.source = oldSource.slice(0, oldSource.lastIndexOf(':') + 1) + DENSITY_PROFILE;
    walk.previousSources = [...new Set([oldSource, ...(walk.previousSources || [])])];
    walk.densityProfile = { id: DENSITY_PROFILE, ceiling: 40, previousPoints: before, targetPoints: target, addedOrders: additions, method: 'largest uncovered gap along existing walking edges' };
  }
  return walk;
}
