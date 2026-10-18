import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSvgSource, verifySvgEvidence, renderSourceEvidenceSvg, renderComparison, collectSourceShapeIds, DEFAULT_SOURCE_DIR } from './svg-tools.mjs';
import { upperFloors } from './data/upper-floors.mjs';
import { lowerFloors } from './data/lower-floors.mjs';
import { createReviewGraph } from './review-graph.mjs';

const readData = name => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8'));

test('shape enumeration follows pipeline path-first order and retains exact original path coordinates', () => {
  const svg = '<svg viewBox="0 0 100 50"><rect x="1" y="2" width="9" height="8"/><g transform="translate(2,3)"><path d="M1.2 2.7 A3 4 0 0 1 12.3 15.6Z"/></g><ellipse cx="8" cy="8" rx="3" ry="2"/><path d="M0 0L5 0L5 5Z"/></svg>';
  const inspected = inspectSvgSource(svg);
  assert.deepEqual(inspected.shapes.map(shape => [shape.id, shape.tag]), [['p1', 'path'], ['p2', 'path'], ['p3', 'rect'], ['p4', 'ellipse']]);
  assert.match(inspected.shapes[0].sourceElement, /M1\.2 2\.7 A3 4 0 0 1 12\.3 15\.6Z/);
  assert.equal(inspected.width, 100);
  assert.equal(inspected.height, 50);
  const rendered = renderSourceEvidenceSvg(svg, ['p1'], { title: 'Source <audit>' });
  assert.match(rendered, /transform="translate\(2,3\)"/);
  assert.match(rendered, /M1\.2 2\.7 A3 4 0 0 1 12\.3 15\.6Z/);
  assert.match(rendered, /Source &lt;audit&gt;/);
  assert.match(rendered, /id="evidence-p1"/);
  assert.throws(() => renderSourceEvidenceSvg(svg, ['p999']), /unknown pN/);
  const explicitClose = renderSourceEvidenceSvg('<svg viewBox="0 0 5 5"><path d="M0 0L5 0L5 5Z"></path></svg>', ['p1']);
  assert.equal((explicitClose.match(/<\/path>/g) || []).length, 1, 'Do not duplicate an explicit closing tag');
});

test('all six floors source references and hashes are valid while PDF frames remain unregistered', () => {
  const audit = verifySvgEvidence([...lowerFloors, ...upperFloors]);
  assert.equal(audit.ok, true, JSON.stringify(audit.issues));
  assert.deepEqual(audit.floors.map(floor => [floor.id, floor.shapeCount]), [['LB', 990], ['L1', 1377], ['L2', 1223], ['L3', 704], ['L4', 1127], ['L5', 877]]);
  for (const floor of audit.floors) {
    assert.equal(floor.sourceHashMatches, true);
    assert.equal(floor.missingReferences.length, 0);
    assert.ok(floor.referenceCount > 0);
    assert.equal(floor.frameComparison.registration, 'unregistered');
    assert.equal(floor.frameComparison.reportToSourceTransform, null);
    assert.equal(floor.frameComparison.dimensionsMatch, false);
  }
});

test('audit rejects non-existent nested source IDs and a source frame from another floor', () => {
  const floor = structuredClone(upperFloors[0]);
  floor.regions[0].sourceShapeIds.push('p999999');
  floor.doors[0].sourceFrameId = 'svg-original-L3';
  floor.candidateLandings = [{ id: 'landing', evidence: { sourceShapeIds: ['p999998'] } }];
  const audit = verifySvgEvidence([floor]);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.floors[0].missingReferences.map(ref => ref.shapeId), ['p999999', 'p999998']);
  assert.ok(audit.issues.some(issue => issue.code === 'reference-frame-mismatch'));
});

test('audit includes separate review-graph anchors and validates their coordinateFrameId', () => {
  const floors = [...lowerFloors, ...upperFloors];
  const reviewGraph = createReviewGraph(readData('review-inventory.json'), floors, readData('review-questions.json'));
  const before = verifySvgEvidence(floors), after = verifySvgEvidence(floors, { reviewGraph });
  assert.equal(after.ok, true, JSON.stringify(after.issues));
  assert.equal(after.reviewGraphEvidenceIncluded, true);
  assert.equal(after.reviewedLandingRecords, 62);
  assert.ok(after.floors.reduce((n, floor) => n + floor.referenceCount, 0) > before.floors.reduce((n, floor) => n + floor.referenceCount, 0));
  const anchor = reviewGraph.landings.find(landing => landing.floorId === 'L2' && landing.depictionAnchor).depictionAnchor;
  anchor.sourceShapeIds.push('p999999');
  anchor.coordinateFrameId = 'L2:report-crop-normalized';
  const rejected = verifySvgEvidence(floors, { reviewGraph });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some(issue => issue.code === 'missing-source-shape' && issue.path.includes('reviewGraphLandings')));
  assert.ok(rejected.issues.some(issue => issue.code === 'reference-frame-mismatch' && issue.path.includes('depictionAnchor')));
  reviewGraph.landings.push({ id: 'bad-association', floorId: 'L99', depictionAnchor: { sourceShapeIds: ['p1'] } });
  assert.ok(verifySvgEvidence(floors, { reviewGraph }).issues.some(issue => issue.code === 'unassigned-review-evidence'));
});

test('recursive source selection includes doorway-only and core evidence, with no duplicate IDs', () => {
  const definition = {
    regions: [{ sourceShapeIds: ['p1', 'p20'] }],
    doors: [{ sourceShapeIds: ['p3', 'p1'] }],
    reviewGraphLandings: [{ depictionAnchor: { sourceShapeIds: ['p8'] } }],
    excludedFeatures: [{ sourceShapeIds: ['p5'] }],
  };
  assert.deepEqual(collectSourceShapeIds(definition), ['p1', 'p3', 'p5', 'p8', 'p20']);
  assert.throws(() => collectSourceShapeIds({ sourceShapeIds: ['unqualified'] }), /original pN/);
});

test('swapping source floor files fails the frozen hash and dimension checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sam-svg-swap-'));
  try {
    writeFileSync(join(directory, 'Level-2-original.svg'), readFileSync(join(DEFAULT_SOURCE_DIR, 'Level-3-original.svg')));
    const audit = verifySvgEvidence([upperFloors[0]], { sourceDir: directory });
    assert.equal(audit.ok, false);
    assert.ok(audit.issues.some(issue => issue.code === 'source-hash-mismatch'));
    assert.ok(audit.issues.some(issue => issue.code === 'source-dimension-mismatch'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('same-size modified SVG is rejected even when every cited shape still exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sam-svg-tamper-'));
  try {
    const original = readFileSync(join(DEFAULT_SOURCE_DIR, 'Level-2-original.svg'), 'utf8');
    writeFileSync(join(directory, 'Level-2-original.svg'), original.replace('</svg>', '<!-- changed -->\n</svg>'));
    const audit = verifySvgEvidence([upperFloors[0]], { sourceDir: directory });
    assert.equal(audit.ok, false);
    assert.equal(audit.floors[0].missingReferences.length, 0);
    assert.ok(audit.issues.some(issue => issue.code === 'source-hash-mismatch'));
    assert.ok(!audit.issues.some(issue => issue.code === 'source-dimension-mismatch'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('floor dimensions and report-coordinate frames cannot masquerade as SVG geometry', () => {
  const floor = structuredClone(upperFloors[0]);
  floor.width = 1626;
  floor.height = 698;
  floor.sourceFrameId = 'L2:report-crop-normalized';
  floor.coordinateFrame = 'L2:report-crop-normalized';
  floor.sourceFile = 'source/Level-3-original.svg';
  const audit = verifySvgEvidence([floor]);
  assert.equal(audit.ok, false);
  for (const code of ['source-frame-mismatch', 'coordinate-frame-mismatch', 'source-dimension-mismatch', 'source-file-mismatch']) assert.ok(audit.issues.some(issue => issue.code === code), code);
});

test('static comparison uses frozen original source and normalized SVG geometry', () => {
  const floor = upperFloors[0];
  const svg = renderComparison(floor);
  assert.match(svg, /L2 DRAFT/);
  assert.match(svg, /viewBox="0 0 781 333"/);
  assert.match(svg, /<polygon/);
  assert.match(svg, /L2:P06/);
  assert.match(svg, /unmeasured|No measured scale/);
  assert.throws(() => renderComparison(floor, { originalSvg: readFileSync(join(DEFAULT_SOURCE_DIR, 'Level-3-original.svg'), 'utf8') }), /source hash/);
  assert.throws(() => renderComparison(floor, { reportImage: 'https://example.org/image.png' }), /inline PNG or JPEG/);
  const badGeometry = structuredClone(floor);
  badGeometry.regions[0].polygon[0] = [781, 333];
  assert.throws(() => renderComparison(badGeometry), /normalized original-SVG/);
  const candidateFloor = structuredClone(floor);
  candidateFloor.doors[0].status = 'candidate';
  const candidateSvg = renderComparison(candidateFloor);
  assert.match(candidateSvg, /data-status="candidate"[^>]*stroke="#8d3f9c"[^>]*stroke-dasharray="3 2"/);
  assert.match(candidateSvg, /unresolved threshold; excluded from navigation/);
  assert.match(candidateSvg, /data-status="draft"[^>]*stroke="#e34805"/);
});
