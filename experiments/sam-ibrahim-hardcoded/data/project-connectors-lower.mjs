/**
 * Sam Ibrahim project-only connector assumptions, authored in ORIGINAL SVG
 * viewBox units. PDF pages 7/8 supply identities, not geometry coordinates.
 * A landing point is on the circulation side of its approximate threshold;
 * it never denotes the centre of a shaft or a stair-flight polygon.
 * No point, threshold, service-floor match or accessible route is surveyed.
 */

const assumptions = {
  geometryBasis: 'svg-traced',
  review: { status: 'agent-inspected' },
  evidenceStatus: 'project-assumed',
  accessibilityVerified: false,
};

const corridor = (id, polygon, sourceShapeIds, note) => ({
  id, polygon, sourceShapeIds, note, ...assumptions,
});

const landing = (floorId, coreId, point, threshold, sourceShapeIds, approachPath,
  approachRegionIds, attachToRegionIds, note, horizontalStatus = 'assumed') => ({
  id: `${floorId}-project-${coreId}`,
  coreId,
  type: coreId.startsWith('elevator') ? 'elevator' : 'stairs',
  point, threshold, sourceShapeIds, approachPath, approachRegionIds,
  attachToRegionIds, horizontalStatus, note, ...assumptions,
});

export const lowerConnectorFloors = [
  {
    floorId: 'LB', width: 839, height: 356, reviewPage: 8,
    coordinateFrame: 'svg-original-LB', sourceFrameId: 'svg-original-LB',
    sourceFile: 'source/Level-B-original.svg',
    corridors: [
      corridor('LB-project-core-c-approach', [
        [333, 111], [341, 113], [341, 185], [453, 185],
        [453, 195], [331, 195], [331, 116],
      ], ['p632', 'p668', 'p384'],
      'The western arm reaches the floor side of PDF P24 below Stair C. The east-west arm at y185-195 stays south of the open steps at x350-382,y130-166 and north of the column near (393,206). Its east end overlaps the existing central strip. The path does not cross the white curved enclosure beneath C.'),
      corridor('LB-project-stair-b-approach', [
        [510, 314], [519, 314], [519, 327], [510, 327],
      ], ['p897', 'p851'],
      'Short branch from the existing south corridor to the circulation side of the distinct southern doorway notch under Stair B. It stops below the yellow core and does not traverse the stair flight.'),
      corridor('LB-project-elevator-b-approach', [
        [453, 282], [467, 282], [467, 289], [459, 296], [453, 296],
      ], ['p632', 'p852'],
      'Short p632 circulation wedge west of the blue B shaft. The floor-side point is outside the blue shaft; its visible west notch supplies the approximate threshold.'),
      corridor('LB-project-elevator-c-approach', [
        [447, 85], [458, 85], [458, 94], [447, 94],
      ], ['p632', 'p670'],
      'Short p632 strip between the original central corridor and the east face of blue shaft C. No shaft interior becomes walkable floor.'),
      corridor('LB-project-core-d-approach', [
        [742, 122], [753, 122], [753, 142], [742, 142],
      ], ['p717', 'p677'],
      'A local floor-side strip follows p717 below the southwest end of D. A thin black boundary remains between p717 and the existing east strip p724, so no join crosses it. The existing unconfirmed south join is also not bridged.'),
    ],
    joins: [
      { id: 'LB-project-c-join', regionIds: ['LB-route-central-south', 'LB-project-core-c-approach'], segment: [[445, 186], [445, 194]], sourceShapeIds: ['p632'] },
      { id: 'LB-project-b-join', regionIds: ['LB-route-central-south', 'LB-project-stair-b-approach'], segment: [[511, 323], [518, 323]], sourceShapeIds: ['p897'] },
      { id: 'LB-project-eb-join', regionIds: ['LB-route-central-south', 'LB-project-elevator-b-approach'], segment: [[459, 283], [459, 291]], sourceShapeIds: ['p632'] },
      { id: 'LB-project-ec-join', regionIds: ['LB-route-central-south', 'LB-project-elevator-c-approach'], segment: [[454, 86], [454, 93]], sourceShapeIds: ['p632'] },
    ],
    landings: [
      landing('LB', 'stair-A', [131, 271], [[126, 274], [136, 274]],
        ['p856', 'p83'], [], [], [],
        'PDF LB-SA/P21/P22 identify Stair A, but the path from current central circulation crosses auditorium/service boundaries. Record a floor-side depiction without a graph attachment; the exact public approach remains unresolved.', 'unresolved'),
      landing('LB', 'stair-B', [514, 315], [[510, 311], [519, 311]],
        ['p851', 'p897'], [[514, 327], [514, 315]],
        ['LB-route-central-south', 'LB-project-stair-b-approach'], ['LB-route-central-south'],
        'PDF LB-SB/P23 matches the southern arched notch visible in p851/p897. Project assumes re-entry to the same named B core on other levels. The point remains below the threshold.'),
      landing('LB', 'stair-C', [337, 114], [[335, 105], [343, 108]],
        ['p632', 'p668', 'p384'], [[453, 190], [336, 190], [336, 121], [337, 114]],
        ['LB-route-central-south', 'LB-project-core-c-approach'], ['LB-route-central-south'],
        'PDF LB-SC/P24 matches the lower-left C opening. The long approach deliberately goes west of the open steps, then east to the original central strip. Adjacent-floor C continuity is a project assumption.'),
      landing('LB', 'stair-D', [747, 124], [[741, 120], [753, 120]],
        ['p677', 'p717', 'p724'], [[747, 140], [747, 124]],
        ['LB-project-core-d-approach'], [],
        'PDF LB-SD/P25 identifies D. Its local floor-side point is supported by p717, but a thin original black boundary separates that fill from p724. The public approach remains unresolved rather than making a shortcut through the boundary or service rooms.', 'unresolved'),
      landing('LB', 'elevator-B', [466, 285], [[468, 282], [468, 289]],
        ['p852', 'p632'], [[453, 294], [459, 289], [466, 285]],
        ['LB-route-central-south', 'LB-project-elevator-b-approach'], ['LB-route-central-south'],
        'PDF LB-EB/P27 matches the west notch of the blue shaft next to B. The project assumes the same elevator serves the displayed floors; operation, clearances and accessible access are unverified.'),
      landing('LB', 'elevator-C', [449, 89], [[445, 85], [445, 94]],
        ['p670', 'p632'], [[458, 89], [449, 89]],
        ['LB-route-central-south', 'LB-project-elevator-c-approach'], ['LB-route-central-south'],
        'PDF LB-EC/P26 identifies the blue shaft east of C. This node sits east of the shaft on original circulation. Elevator service continuity is explicitly assumed for the project.'),
    ],
    paths: [],
  },
  {
    floorId: 'L1', width: 843, height: 367, reviewPage: 7,
    coordinateFrame: 'svg-original-L1', sourceFrameId: 'svg-original-L1',
    sourceFile: 'source/Level-1-original.svg',
    corridors: [
      corridor('L1-project-core-c-approach', [
        [306, 111], [320, 108], [331, 113], [331, 119],
        [320, 124], [307, 130], [305, 124],
      ], ['p921', 'p923', 'p957', 'p992'],
      'A conservative lobby-side wedge west of the C core joins the existing northwest lobby strip. It stops on the west side of the approximate P14 threshold and does not cross the white enclosure or the triangular open stair below the core.'),
      corridor('L1-project-elevator-c-approach', [
        [437, 92], [443, 92], [452, 111], [442, 121],
        [435, 119], [441, 108],
      ], ['p921', 'p950', 'p958', 'p961'],
      'Lobby-side strip east of elevator C, outside its blue shaft and the narrow grey boundary detail. The threshold is approximated at the east shaft notch; the route ends in the adjoining lobby rather than claiming travel inside that detail.'),
      corridor('L1-project-core-b-approach', [
        [514, 163], [523, 163], [523, 205], [522, 226],
        [516, 244], [510, 255], [447, 257], [447, 244],
        [504, 244], [508, 237], [512, 224], [513, 204],
      ], ['p921', 'p1028', 'p1192'],
      'The stair B approach goes south along the lobby east of Dark Matter and then west between its southern wall and the B core. A thin wall separates this strip from the west lobby near x422,y249; the path goes around the classroom through the existing northern concourse instead of cutting that wall.'),
      corridor('L1-project-elevator-b-approach', [
        [382, 228], [389, 229], [392, 244], [396, 247], [421, 247.8],
        [425, 264], [426.5, 272], [422, 273],
        [417, 252], [393, 253], [380, 235],
      ], ['p921', 'p1183', 'p1199'],
      'The elevator B arm passes below the small central step boundary at y244, then stays east of the slender triangular wall near (393,263)-(407,300) and west of the shaft. It does not cross the thin boundary separating this lobby from stair B north approach.'),
      corridor('L1-project-core-d-approach', [
        [679, 120], [691, 120], [704, 128], [720, 138],
        [716, 147], [699, 137], [683, 127],
      ], ['p921', 'p909', 'p964', 'p965'],
      'Short approach inside the north-east lobby p921 south of D. This ends beneath the west side of the yellow D core, without following the posted YOU ARE HERE arrow or exterior exit markers.'),
    ],
    joins: [
      { id: 'L1-project-c-join', regionIds: ['L1-route-lobby', 'L1-project-core-c-approach'], segment: [[307, 114], [307, 123]], sourceShapeIds: ['p921'] },
      { id: 'L1-project-ec-join', regionIds: ['L1-route-lobby', 'L1-project-elevator-c-approach'], segment: [[441, 115], [447, 115]], sourceShapeIds: ['p921'] },
      { id: 'L1-project-b-join', regionIds: ['L1-route-lobby', 'L1-project-core-b-approach'], segment: [[515, 167], [521, 167]], sourceShapeIds: ['p921'] },
      { id: 'L1-project-eb-join', regionIds: ['L1-route-lobby', 'L1-project-elevator-b-approach'], segment: [[384, 229], [384, 231]], sourceShapeIds: ['p921'] },
      { id: 'L1-project-d-join', regionIds: ['L1-route-lobby', 'L1-project-core-d-approach'], segment: [[706, 136], [712, 142]], sourceShapeIds: ['p921'] },
    ],
    landings: [
      landing('L1', 'stair-A', [110, 260], [[113, 260], [121, 260]],
        ['p1154', 'p1187', 'p1197'], [], [], [],
        'PDF L1-SA/P12 identifies the southwest core. The southwest vestibule and intervening open steps separate it from the current main-lobby trace. No floor-side graph attachment is asserted; X11 remains an exterior exit-group observation.', 'unresolved'),
      landing('L1', 'stair-B', [452, 254], [[449, 258], [457, 258]],
        ['p921', 'p1028', 'p1192', 'p1195', 'p1214'], [[519, 168], [518, 204], [516, 226], [512, 241], [506, 249], [452, 249], [452, 254]],
        ['L1-route-lobby', 'L1-project-core-b-approach'], ['L1-route-lobby'],
        'PDF L1-SB/P13 places the entrance at the north-west edge of B. Approach from the northern concourse goes around Dark Matter east and south, avoiding the thin wall that separates this side from elevator B lobby. X10 does not become an extra exterior route.'),
      landing('L1', 'stair-C', [329, 116], [[335, 115], [343, 118]],
        ['p921', 'p957', 'p992'], [[306, 122], [320, 117], [329, 116]],
        ['L1-route-lobby', 'L1-project-core-c-approach'], ['L1-route-lobby'],
        'PDF L1-SC/P14 matches the lower-left C entry. Stop on the lobby side west of the grey threshold detail. The open triangular stair below C is a separate feature and receives no connector edge.'),
      landing('L1', 'stair-D', [686, 122], [[683, 116], [691, 116]],
        ['p921', 'p909', 'p964', 'p965'], [[713, 142], [704, 133], [686, 122]],
        ['L1-route-lobby', 'L1-project-core-d-approach'], ['L1-route-lobby'],
        'PDF L1-SD/P15 matches the southwest D entry. The point is in the lobby beneath it. Neither the posted location marker nor X05 establishes a user position or additional exit route.'),
      landing('L1', 'elevator-B', [424, 271], [[427, 270], [427, 275]],
        ['p921', 'p1183', 'p1199'], [[386, 230], [390, 242], [396, 249], [421, 249], [424, 263], [424, 271]],
        ['L1-route-lobby', 'L1-project-elevator-b-approach'], ['L1-route-lobby'],
        'PDF L1-EB/P17 matches the blue B shaft west notch around y272. The approach remains west of the shaft but east of the isolated triangular wall. Step-free service and measured clearance are unknown.'),
      landing('L1', 'elevator-C', [439, 95], [[424, 89], [423, 96]],
        ['p921', 'p950', 'p958', 'p961'], [[441, 117], [446, 110], [439, 95]],
        ['L1-route-lobby', 'L1-project-elevator-c-approach'], ['L1-route-lobby'],
        'PDF L1-EC/P16 identifies the blue C shaft. The point is outside the narrow boundary detail, in the east lobby; the exact threshold offset is retained explicitly rather than moving the route into the shaft. Same-core elevator service is project-assumed.'),
    ],
    paths: [],
  },
];
