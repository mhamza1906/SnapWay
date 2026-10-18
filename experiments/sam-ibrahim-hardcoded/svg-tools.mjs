// Read-only source audit tools. The existing pipeline owns pN enumeration;
// these helpers never run its renderer, vectorizer, provider, or HTTP server.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactSvg } from '../../apps/pipeline/server/svg-analysis.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./data/source-manifest.json', import.meta.url), 'utf8'));
export const DEFAULT_SOURCE_DIR = join(directory, 'source');
const hash = value => createHash('sha256').update(value).digest('hex');
const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const expectedSource = floorId => manifest.sources.find(source => source.floorId === floorId && source.role === 'source-vectorized-original');
const reportFrame = floorId => manifest.coordinateFrames.find(frame => frame.id === `${floorId}:report-crop-normalized`);
const frameNames = floorId => new Set([`${floorId}:original-svg-viewbox`, `svg-original-${floorId}`]);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Inspect original elements with exactly the pipeline's path-first pN IDs.
 * sourceElement retains the original coordinates/arcs. bbox is the pipeline's
 * approximate compact-path summary, not a polygon or a surveyed boundary.
 */
export function inspectSvgSource(svg) {
  requireThat(typeof svg === 'string' && /<svg\b/.test(svg), 'SVG source must be an SVG string');
  const compact = compactSvg(svg);
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/\s+/).map(Number);
  requireThat(viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0, 'SVG needs a finite positive viewBox');
  // Do not enumerate in DOM order: compactSvg processes every path before
  // its rect/ellipse pass, even when those elements occur earlier in the SVG.
  const elements = [
    ...svg.matchAll(/<path([^>]*?)\/?>/g),
    ...svg.matchAll(/<(rect|ellipse)([^>]*?)\/?>/g),
  ].map(match => match[0]);
  requireThat(elements.length === compact.shapes.length, 'Original SVG enumeration disagrees with pipeline compactSvg');
  return {
    width: compact.width, height: compact.height, viewBox, shapeCount: compact.shapes.length,
    sourceHash: hash(svg), enumeration: 'pipeline compactSvg: paths first, then rect/ellipse in their document order',
    shapes: compact.shapes.map((shape, index) => ({
      ...shape, tag: /^<(\w+)/.exec(elements[index])[1], sourceElement: elements[index],
      bboxMeaning: 'Approximate compact-path bounds; not walkability or semantic evidence by itself.',
    })),
  };
}

function referenceOwners(value, path = 'floor', result = [], visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return result;
  visited.add(value);
  if ('sourceShapeIds' in value || 'sourceFrameId' in value) result.push({ value, path });
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceShapeIds') continue;
    if (Array.isArray(child)) child.forEach((item, i) => referenceOwners(item, `${path}.${key}[${i}]`, result, visited));
    else if (child && typeof child === 'object') referenceOwners(child, `${path}.${key}`, result, visited);
  }
  return result;
}

/** All cited original shapes, including doorway details, cores and exclusions. */
export function collectSourceShapeIds(value) {
  const ids = new Set();
  for (const { value: owner, path } of referenceOwners(value)) {
    if (!('sourceShapeIds' in owner)) continue;
    requireThat(Array.isArray(owner.sourceShapeIds) && owner.sourceShapeIds.every(id => typeof id === 'string' && /^p\d+$/.test(id)), `${owner.id || path}: sourceShapeIds must contain original pN IDs`);
    owner.sourceShapeIds.forEach(id => ids.add(id));
  }
  return [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const landingFloorId = landing => landing.floorId || landing.depictedOnFloorId;
const evidenceFrame = owner => owner.sourceFrameId || owner.coordinateFrameId || owner.coordinateFrame;

/**
 * Verify frozen source identity, source frame, and every cited pN reference.
 * A successful audit establishes reproducible references, not physical access.
 * Geometry stays in SVG coordinates; the PDF inventory has a separate frame.
 */
export function verifySvgEvidence(floors, { sourceDir = DEFAULT_SOURCE_DIR, reviewGraph } = {}) {
  requireThat(Array.isArray(floors), 'verifySvgEvidence expects an array of floor definitions');
  const issues = [], results = [];
  const floorIds = new Set(floors.map(floor => floor?.id));
  const reviewLandings = reviewGraph?.landings || [];
  for (const landing of reviewLandings) {
    if (referenceOwners(landing).some(({ value }) => value.sourceShapeIds?.length) && !floorIds.has(landingFloorId(landing))) {
      issues.push({ code: 'unassigned-review-evidence', floorId: landingFloorId(landing) || null, message: `${landing.id}: original SVG references need a known floor or depictedOnFloorId`, ownerId: landing.id });
    }
  }
  const seen = new Set();
  for (const definition of floors) {
    const floor = definition && typeof definition === 'object' && reviewGraph
      ? { ...definition, reviewGraphLandings: reviewLandings.filter(landing => landingFloorId(landing) === definition.id) }
      : definition;
    const id = floor?.id;
    const result = {
      id: id ?? null, ok: true, shapeCount: null, width: null, height: null,
      sourceHash: null, expectedSourceHash: null, sourceHashMatches: false,
      missingReferences: [], referenceCount: 0, uniqueReferencedShapeIds: [], issues: [],
      semanticVerification: 'Shape identity is checked; semantic meaning, door access, and landing connectivity remain agent-authored draft interpretations.',
    };
    const issue = (code, message, detail = {}) => {
      const item = { code, floorId: id ?? null, message, ...detail };
      result.issues.push(item);
      issues.push(item);
      result.ok = false;
    };
    results.push(result);
    if (!floor || typeof floor !== 'object' || typeof id !== 'string') {
      issue('invalid-floor', 'Floor definition needs an id');
      continue;
    }
    if (seen.has(id)) issue('duplicate-floor', `Duplicate floor definition: ${id}`);
    seen.add(id);
    const source = expectedSource(id);
    if (!source) {
      issue('unknown-source', `No frozen original SVG is registered for ${id}`);
      continue;
    }
    result.expectedSourceHash = source.sha256;
    result.sourceManifestId = source.id;
    const filename = basename(source.relativePath);
    result.sourceFile = `source/${filename}`;
    if (floor.sourceFile && floor.sourceFile !== result.sourceFile && floor.sourceFile !== filename) {
      issue('source-file-mismatch', `${id}: sourceFile does not identify its registered original SVG`, { actual: floor.sourceFile, expected: result.sourceFile });
    }
    let svg, inspected;
    try {
      svg = readFileSync(join(sourceDir, filename), 'utf8');
      inspected = inspectSvgSource(svg);
    } catch (error) {
      issue('source-read-error', `${id}: ${error.message}`);
      continue;
    }
    Object.assign(result, { shapeCount: inspected.shapeCount, width: inspected.width, height: inspected.height, viewBox: inspected.viewBox, sourceHash: inspected.sourceHash });
    result.sourceHashMatches = inspected.sourceHash === source.sha256;
    if (!result.sourceHashMatches) issue('source-hash-mismatch', `${id}: source differs from the frozen original SVG`, { expected: source.sha256, actual: inspected.sourceHash });
    if (floor.sourceHash && floor.sourceHash !== inspected.sourceHash) issue('declared-hash-mismatch', `${id}: floor's declared source hash disagrees with the loaded SVG`);
    if (floor.width !== inspected.width || floor.height !== inspected.height) {
      issue('source-dimension-mismatch', `${id}: geometry dimensions do not match its original SVG viewBox`, { expected: { width: inspected.width, height: inspected.height }, actual: { width: floor.width, height: floor.height } });
    }
    if (JSON.stringify(source.viewBox) !== JSON.stringify(inspected.viewBox)) issue('source-viewbox-mismatch', `${id}: source viewBox differs from the manifest`);
    const names = frameNames(id);
    if (!names.has(floor.sourceFrameId)) issue('source-frame-mismatch', `${id}: sourceFrameId must name this floor's original SVG frame`, { actual: floor.sourceFrameId ?? null, accepted: [...names] });
    if (floor.coordinateFrame && !names.has(floor.coordinateFrame)) issue('coordinate-frame-mismatch', `${id}: coordinateFrame is not its original SVG frame`, { actual: floor.coordinateFrame });
    const existing = new Set(inspected.shapes.map(shape => shape.id)), referenced = new Set();
    for (const { value: owner, path } of referenceOwners(floor)) {
      const ownerFrame = evidenceFrame(owner);
      if (ownerFrame && !names.has(ownerFrame)) issue('reference-frame-mismatch', `${owner.id || path}: cited shapes belong to another coordinate frame`, { ownerId: owner.id || null, path, actual: ownerFrame });
      if (!('sourceShapeIds' in owner)) continue;
      if (!Array.isArray(owner.sourceShapeIds)) {
        issue('invalid-shape-references', `${owner.id || path}: sourceShapeIds must be an array`, { ownerId: owner.id || null, path });
        continue;
      }
      for (const shapeId of owner.sourceShapeIds) {
        result.referenceCount++;
        referenced.add(shapeId);
        if (typeof shapeId !== 'string' || !existing.has(shapeId)) {
          const missing = { ownerId: owner.id || null, path, shapeId };
          result.missingReferences.push(missing);
          issue('missing-source-shape', `${owner.id || path}: original SVG does not contain ${String(shapeId)}`, missing);
        }
      }
    }
    for (const [kind, objects] of [['regions', floor.regions || []], ['doors', floor.doors || []]]) {
      for (const object of objects) {
        if (!(object.sourceShapeIds?.length > 0)) issue('uncited-geometry', `${object.id}: ${kind} geometry needs original SVG shape references`, { ownerId: object.id });
      }
    }
    result.uniqueReferencedShapeIds = [...referenced].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
    const report = reportFrame(id);
    if (report) {
      result.frameComparison = {
        sourceFrameId: source.coordinateFrameId,
        authoredFrameAlias: floor.sourceFrameId,
        reportFrameId: report.id,
        reportOverlayPixelWidth: report.reportOverlayPixelWidth,
        reportOverlayPixelHeight: report.reportOverlayPixelHeight,
        dimensionsMatch: inspected.width === report.reportOverlayPixelWidth && inspected.height === report.reportOverlayPixelHeight,
        sourceAspectRatio: inspected.width / inspected.height,
        reportOverlayAspectRatio: report.reportOverlayPixelWidth / report.reportOverlayPixelHeight,
        registration: 'unregistered',
        reportToSourceTransform: null,
        note: 'Report centers locate annotations only. Report overlay raster dimensions differ from the SVG and do not justify scaling those centers into geometry. Report IDs/names provide a semantic cross-check; vertices are authored against SVG paths.',
      };
    }
  }
  return { ok: issues.length === 0, floors: results, issues, reviewGraphEvidenceIncluded: Boolean(reviewGraph), reviewedLandingRecords: reviewLandings.length };
}

function svgInner(svg) {
  return svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

function assertStaticSvg(svg) {
  requireThat(!/<(?:script|foreignObject|iframe|image|use)\b/i.test(svg) && !/\son\w+\s*=/i.test(svg), 'Evidence SVG must be a static path source without executable or external elements');
}

/** Highlight selected original elements in their original group context. */
export function renderSourceEvidenceSvg(svg, shapeIds, { title = 'DRAFT — original SVG source evidence', labelIds = false } = {}) {
  assertStaticSvg(svg);
  const inspected = inspectSvgSource(svg), selected = new Set(shapeIds);
  const existing = new Set(inspected.shapes.map(shape => shape.id));
  requireThat([...selected].every(id => existing.has(id)), 'Source evidence selection contains an unknown pN shape ID');
  let count = 0;
  const mark = (element, tag, attrs) => {
    const id = `p${++count}`;
    const chosen = selected.has(id);
    const styleMatch = /\sstyle="([^"]*)"/.exec(attrs);
    const style = `${styleMatch?.[1] || ''};${chosen ? 'stroke:#d4145a;stroke-width:1.5;fill-opacity:0.35;opacity:1' : 'opacity:0.16'}`;
    const cleaned = attrs.replace(/\sid="[^"]*"/g, '').replace(/\sstyle="[^"]*"/g, '').replace(/\s*\/$/, '');
    return `<${tag} id="evidence-${id}"${cleaned} style="${escapeXml(style)}"><title>${id}${chosen ? ' — selected evidence' : ''}</title>${/\/>$/.test(element) ? `</${tag}>` : ''}`;
  };
  // Keep every group's transform/style and each path's exact d attribute.
  const marked = svg
    .replace(/<path([^>]*?)\/?>/g, (element, attrs) => mark(element, 'path', attrs))
    .replace(/<(rect|ellipse)([^>]*?)\/?>/g, (element, tag, attrs) => mark(element, tag, attrs));
  const labels = labelIds ? inspected.shapes.filter(shape => selected.has(shape.id) && shape.bbox).map(shape => `<text x="${shape.bbox[0]}" y="${shape.bbox[1]}" font-size="6" fill="#a5003c">${shape.id}</text>`).join('') : '';
  const [x, y, width, height] = inspected.viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y - 25} ${width} ${height + 25}"><title>${escapeXml(title)}</title><rect x="${x}" y="${y - 25}" width="${width}" height="${height + 25}" fill="white"/><text x="${x + 6}" y="${y - 10}" font-family="sans-serif" font-size="10">${escapeXml(title)}</text>${svgInner(marked)}${labels}</svg>`;
}

/**
 * Static review artifact only: original source plus manually authored geometry.
 * reportImage may be a data:image/png;base64,... or JPEG data URL. If supplied,
 * it is displayed alongside the source without asserting frame registration.
 */
export function renderComparison(floor, { originalSvg, reportImage } = {}) {
  const source = expectedSource(floor.id);
  requireThat(source, `No original SVG manifest entry for ${floor.id}`);
  const svg = originalSvg ?? readFileSync(join(DEFAULT_SOURCE_DIR, basename(source.relativePath)), 'utf8');
  assertStaticSvg(svg);
  const inspected = inspectSvgSource(svg);
  requireThat(inspected.sourceHash === source.sha256, `${floor.id}: source hash does not match its frozen original SVG`);
  requireThat(floor.width === inspected.width && floor.height === inspected.height && frameNames(floor.id).has(floor.sourceFrameId), `${floor.id}: geometry source frame does not match original SVG`);
  const shapeIds = new Set(inspected.shapes.map(shape => shape.id));
  for (const { value: owner } of referenceOwners(floor)) {
    requireThat(!evidenceFrame(owner) || frameNames(floor.id).has(evidenceFrame(owner)), `${owner.id || floor.id}: source frame does not match original SVG`);
    if ('sourceShapeIds' in owner) requireThat(Array.isArray(owner.sourceShapeIds) && owner.sourceShapeIds.every(id => shapeIds.has(id)), `${owner.id || floor.id}: original SVG shape reference is invalid`);
  }
  const width = inspected.width, height = inspected.height, header = 50, gap = 18;
  const points = pairs => pairs.map(([x, y]) => {
    requireThat(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1, 'Overlay geometry must use normalized original-SVG coordinates');
    return `${x * width},${y * height}`;
  }).join(' ');
  const regions = (floor.regions || []).map(region => `<polygon points="${points(region.polygon)}" fill="${region.kind === 'corridor' ? '#29aa75' : '#3e73cf'}" fill-opacity="0.16" stroke="${region.kind === 'corridor' ? '#087b4b' : '#2759a5'}" stroke-width="0.8"><title>${escapeXml(region.id)} — ${escapeXml(region.label || region.id)}</title></polygon>`).join('');
  const doors = (floor.doors || []).map(door => {
    const candidate = door.status === 'candidate';
    return `<polyline data-status="${candidate ? 'candidate' : 'draft'}" points="${points(door.segment)}" fill="none" stroke="${candidate ? '#8d3f9c' : '#e34805'}" stroke-width="2"${candidate ? ' stroke-dasharray="3 2"' : ''}><title>${escapeXml(door.id)} — ${candidate ? 'unresolved threshold; excluded from navigation' : 'draft assumed opening'}</title></polyline>`;
  }).join('');
  const href = typeof reportImage === 'string' ? reportImage : reportImage?.href;
  if (href) requireThat(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(href), 'Report image must be an inline PNG or JPEG data URL');
  const totalWidth = href ? width * 2 + gap : width;
  const reportPanel = href ? `<image x="${width + gap}" y="${header}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="${href}"/><text x="${width + gap}" y="28" font-size="9">PDF comparison image — separate, unregistered frame</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height + header + 20}"><title>${escapeXml(floor.id)} DRAFT — original SVG and manually traced geometry</title><rect width="${totalWidth}" height="${height + header + 20}" fill="white"/><g font-family="sans-serif"><text x="6" y="13" font-size="11">${escapeXml(floor.id)} DRAFT — original SVG + manually traced geometry</text><text x="6" y="28" font-size="9">Green: circulation; blue: room; orange: draft opening; purple dashed: unresolved threshold.</text><text x="6" y="41" font-size="9">Source shape IDs identify evidence; they do not verify physical access.</text><svg x="0" y="${header}" width="${width}" height="${height}" viewBox="${inspected.viewBox.join(' ')}">${svgInner(svg)}${regions}${doors}</svg>${reportPanel}<text x="6" y="${height + header + 13}" font-size="9">Agent-inspected draft. No measured scale, field verification, or automatic PDF-to-SVG coordinate transform.</text></g></svg>`;
}
