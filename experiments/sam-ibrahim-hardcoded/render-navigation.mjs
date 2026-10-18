// Offline review export. All graph positions remain in original SVG units;
// decoration and route composition affect display only.
import { routeDisplaySegments } from '../../apps/pipeline/shared/building/route-display.js';

const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
const coordinate = value => {
  if (!Number.isFinite(value)) throw new Error('Navigation rendering requires finite coordinates.');
  return String(Math.round(value * 1e6) / 1e6);
};
const points = path => path.map(point => `${coordinate(point.x)},${coordinate(point.y)}`).join(' ');
const equalPoint = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
const equalPath = (a, b) => a.length === b.length && a.every((point, index) => equalPoint(point, b[index]));

function assertThat(condition, message) {
  if (!condition) throw new Error(`Navigation SVG: ${message}`);
}

function sourceFrame(svg) {
  assertThat(typeof svg === 'string' && /<svg\b/.test(svg), 'originalSvg must be an SVG string');
  // These frozen vectorizer sources need only static geometry. Reject active
  // or externally resolved content before embedding the original group tree.
  assertThat(!/<(?:script|foreignObject|iframe|object|embed|image|use|a|animate\w*|set|style)\b/i.test(svg) && !/\son\w+\s*=/i.test(svg) && !/(?:href\s*=|url\s*\(|@import)/i.test(svg), 'original source must contain static local geometry only');
  const box = /<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  assertThat(box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0, 'original source requires a positive viewBox');
  assertThat(box[0] === 0 && box[1] === 0, 'this experiment requires a zero-origin source frame');
  return { width: box[2], height: box[3], inner: svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '') };
}

/**
 * Render a static, standalone draft graph review artifact. The original source
 * is faded beneath actual built edge paths and nodes. An optional computed
 * route is composed by the unchanged pipeline's display-only helper.
 * No file writes, HTTP, UI, graph rebuilding or pathfinding occur here.
 */
export function renderNavigationSvg(floorSpec, building, originalSvg, { route = null } = {}) {
  const source = sourceFrame(originalSvg);
  const floor = building?.floors?.find(item => item.id === floorSpec?.id);
  assertThat(floor, `building has no floor ${floorSpec?.id || '(missing)'}`);
  assertThat([floorSpec.width, floor.width].every(width => width === source.width) && [floorSpec.height, floor.height].every(height => height === source.height), 'floor dimensions disagree with the original SVG frame');
  const nodes = building.nodes.filter(node => node.floorId === floor.id);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = building.edges.filter(edge => edge.floorId === floor.id);
  for (const edge of edges) {
    assertThat(nodeIds.has(edge.from) && nodeIds.has(edge.to), `edge ${edge.id} has an endpoint outside this floor`);
    assertThat(edge.path.length >= 2, `edge ${edge.id} needs a path`);
  }
  if (route) {
    assertThat(Array.isArray(route.steps), 'route needs computed steps');
    for (const step of route.steps.filter(step => step.floorId === floor.id)) {
      const edge = edges.find(edge => edge.id === step.edgeId);
      assertThat(edge && (equalPath(step.path, edge.path) || equalPath(step.path, [...edge.path].reverse())), `route step ${step.edgeId} does not match the stored graph path`);
    }
  }
  const segments = routeDisplaySegments(route, floor.id);
  const frame = floorSpec.sourceFrameId || floorSpec.coordinateFrame || `${floor.id}:original-svg-viewbox`;
  const metadata = {
    artifact: 'static-draft-navigation-review', floorId: floor.id, coordinateFrame: frame,
    sourceWidth: source.width, sourceHeight: source.height,
    nodeCount: nodes.length, edgeCount: edges.length, routeSegmentCount: segments.length,
    review: 'agent-inspected', evidence: 'draft-assumed', measuredScale: null,
    physicalNavigationApproved: false,
  };
  const margin = 14, header = 66, footer = 27;
  // Each map unit is a source SVG unit, independent of the output pixel size.
  const width = source.width + margin * 2, height = source.height + header + footer;
  const label = `${floor.label || floorSpec.label || floor.id} — DRAFT NAVIGATION GRAPH`;
  const edgeMarkup = edges.map(edge => `<polyline data-edge-id="${esc(edge.id)}" points="${points(edge.path)}"><title>${esc(edge.id)} · ${esc(edge.traversal)} · accessibility unknown</title></polyline>`).join('');
  const routeMarkup = segments.map((segment, index) => `<polyline data-route-segment="${index}" points="${points(segment.displayPoints)}"><title>Draft route · ${segment.edgeIds.length} graph edges · display composition only</title></polyline>`).join('');
  const nodeMarkup = nodes.map(node => `<circle data-node-id="${esc(node.id)}" cx="${coordinate(node.position.x)}" cy="${coordinate(node.position.y)}" r="${node.doorId ? 2.3 : 1.6}" fill="${node.doorId ? '#e28419' : '#146890'}"><title>${esc(node.id)} · ${esc(node.label)} · ${esc(node.type)}</title></circle>`).join('');
  const endpoints = route ? [['start', route.startNode, '#087f5b'], ['end', route.endNode, '#a72d55']].flatMap(([kind, id, color]) => {
    const node = nodes.find(node => node.id === id);
    return node ? [`<circle data-route-endpoint="${kind}" cx="${coordinate(node.position.x)}" cy="${coordinate(node.position.y)}" r="4.2" fill="white" stroke="${color}" stroke-width="1.6"><title>${kind}: ${esc(node.label)}</title></circle>`] : [];
  }).join('') : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${coordinate(width)}" height="${coordinate(height)}" viewBox="0 0 ${coordinate(width)} ${coordinate(height)}" role="img" aria-labelledby="navigation-title navigation-description">
<title id="navigation-title">${esc(label)}</title>
<desc id="navigation-description">Original SVG underlay, ${nodes.length} built navigation nodes and ${edges.length} stored edge paths. Agent-inspected draft; no measured scale or verified floor transitions.</desc>
<metadata>${esc(JSON.stringify(metadata))}</metadata>
<rect width="100%" height="100%" fill="#ffffff"/>
<g font-family="sans-serif" fill="#193545">
<text x="${margin}" y="19" font-size="13" font-weight="700">${esc(label)}</text>
<text x="${margin}" y="35" font-size="9">${nodes.length} nodes · ${edges.length} edges · ${esc(frame)} · NO MEASURED SCALE</text>
<g font-size="9" transform="translate(${margin} 51)">
<line x1="0" y1="-3" x2="17" y2="-3" stroke="#146890" stroke-width="1.5"/><text x="22">Stored paths</text>
<circle cx="113" cy="-3" r="2.3" fill="#e28419"/><text x="121">Assumed doorway</text>
<circle cx="232" cy="-3" r="1.6" fill="#146890"/><text x="240">Graph vertex</text>
${segments.length ? '<line x1="332" y1="-3" x2="349" y2="-3" stroke="#c13172" stroke-width="3"/><text x="354">Selected draft route</text>' : ''}
</g>
<svg x="${margin}" y="${header}" width="${coordinate(source.width)}" height="${coordinate(source.height)}" viewBox="0 0 ${coordinate(source.width)} ${coordinate(source.height)}">
<g data-layer="original-source" opacity="0.42">${source.inner}</g>
<g data-layer="navigation-edges" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${edgeMarkup.replaceAll('data-edge-id=', 'data-edge-halo=')}</g>
<g data-layer="navigation-edges" fill="none" stroke="#146890" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${edgeMarkup}</g>
<g data-layer="selected-route" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${routeMarkup.replaceAll('data-route-segment=', 'data-route-halo=')}</g>
<g data-layer="selected-route" fill="none" stroke="#c13172" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">${routeMarkup}</g>
<g data-layer="navigation-nodes" stroke="#ffffff" stroke-width="0.7">${nodeMarkup}</g>
${endpoints}
</svg>
<text x="${margin}" y="${source.height + header + 17}" font-size="9">Agent-inspected draft · assumed thresholds · no verified cross-floor routes · source SVG units, not metres.</text>
</g>
</svg>`;
}
