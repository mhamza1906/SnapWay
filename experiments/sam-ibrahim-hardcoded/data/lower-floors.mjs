/**
 * Manual lower-floor geometry in ORIGINAL SVG coordinates, compared with
 * review PDF pages 7/8 and the original photographs. These are conservative
 * routing strips and selected room interiors, not traced annotation boxes.
 *
 * SVG pN references are one-based PATH ordinals, as in the existing analysis
 * files; other SVG shape types do not increment that ordinal. Coordinates
 * below are authored in source viewBox units and exported normalized.
 *
 * Review IDs refer to the PDF inventory semantically. Its image-crop
 * coordinates are a different frame and MUST NOT be used as SVG coordinates.
 * Every doorway and corridor remains an agent-inspected draft. Stair/elevator
 * candidates carry no traversable inter-floor connection or accessibility claim.
 */

function floorFrame(id, width, height, reviewPage) {
  const point = ([x, y]) => [x / width, y / height];
  const points = (coordinates) => coordinates.map(point);
  const evidence = (sourceShapeIds, evidenceNote) => ({
    geometryBasis: 'svg-traced',
    coordinateFrame: `svg-original-${id}`,
    sourceFrameId: `svg-original-${id}`,
    sourceFile: `source/Level-${id === 'LB' ? 'B' : '1'}-original.svg`,
    sourceShapeIds,
    reviewPage,
    evidenceNote,
    review: { status: 'agent-inspected' },
  });
  return {
    point,
    region(id, label, kind, polygon, sourceShapeIds, evidenceNote, extra = {}) {
      return { id, label, kind, polygon: points(polygon), status: 'draft',
        ...evidence(sourceShapeIds, evidenceNote), ...extra };
    },
    door(id, regionIds, segment, sourceShapeIds, evidenceNote, extra = {}) {
      return { id, regionIds, segment: points(segment), status: 'draft',
        ...evidence(sourceShapeIds, evidenceNote), ...extra };
    },
    spine(id, regionId, coordinates, sourceShapeIds, evidenceNote) {
      return { id, regionId, points: points(coordinates), status: 'draft',
        ...evidence(sourceShapeIds, evidenceNote) };
    },
    landing(featureId, connectorKey, kind, at, approach, sourceShapeIds, portalIds, evidenceNote, approachPath) {
      return {
        id: `${featureId}-landing-candidate`, featureId, connectorKey, kind,
        point: point(at), approachPoint: point(approach),
        portalIds: portalIds.map(portalId => `${id}:${portalId}`),
        sourcePortalIds: [...portalIds],
        status: 'candidate', traversable: false,
        ...evidence(sourceShapeIds, evidenceNote),
        ...(approachPath ? {
          approachPath: points(approachPath),
          approachPathStatus: 'draft-unconnected',
          approachPathNote: 'Source-supported circulation-side approach only. Stops before the unverified threshold; excluded from the routing graph.',
        } : {}),
      };
    },
  };
}

const L1 = floorFrame('L1', 843, 367, 7);
const LB = floorFrame('LB', 839, 356, 8);

export const lowerFloors = [
  {
    id: 'LB', label: 'Level B', level: -1, width: 839, height: 356,
    coordinateFrame: 'svg-original-LB',
    sourceFrameId: 'svg-original-LB', geometryBasis: 'svg-traced',
    sourceFile: 'source/Level-B-original.svg',
    sourceSvg: 'Level-B-original.svg',
    sourceImage: 'Level-B-original.png',
    reviewPages: [8, 42, 43, 44],
    sourceShapeIdConvention: 'one-based-path-ordinal',
    geometryNote: 'Source viewBox 0 0 839 356. Manual inset strips follow p632 and the south corridor fills p897/p912/p898; no PDF rectangle is used as a room or walkable boundary.',
    regions: [
      LB.region('LB-route-central-south', 'Central and southern circulation strip', 'corridor', [
        [321, 228], [339, 228], [339, 241], [445, 241],
        [445, 150], [452, 141], [452, 64], [475, 64], [475, 75],
        [464, 80], [464, 221], [475, 225], [475, 235], [464, 239],
        [464, 315], [478, 322], [630, 322], [630, 332], [477, 332],
        [432, 334], [432, 331], [441, 324], [441, 253], [339, 253],
        [339, 307], [323, 307], [321, 280],
      ], ['p632', 'p665', 'p814', 'p897', 'p912', 'p898'],
      'Inset circulation follows the central SVG fill east of the auditorium, passes east of the Green Room, and reaches the south strip. It avoids the open-step mark around (350,130)-(382,166) and the column marks near (393,206)/(394,258). PDF page 8 supports the circulation interpretation; precise scale and door clearances remain unknown.',
      { reportRegionIds: ['LB-C01', 'LB-C02'] }),

      LB.region('LB-route-east', 'East diagonal circulation strip', 'corridor', [
        [631, 288], [631, 260], [643, 230], [678, 146],
        [679, 137], [700, 137], [700, 146], [689, 151],
        [654, 236], [640, 270], [640, 288],
      ], ['p724'],
      'Inset strip follows p724 between the east service rooms and tiered classroom. Its southern join to the south corridor is deliberately omitted: the SVG analysis identifies an interrupted wall around (640,310), which needs threshold confirmation. This strip remains a separate same-floor component.',
      { reportRegionIds: ['LB-C03'] }),

      LB.region('LB-R02', 'The Collaboratorium', 'room', [
        [475, 65], [488, 58], [603, 59], [609, 83], [607, 221],
        [602, 243], [490, 243], [480, 237], [475, 235], [475, 225],
        [477, 212], [475, 89],
      ], ['p641', 'p665', 'p814', 'p131'],
      'Manually simplified inset of p641 with two separate west-side threshold candidates at the p665/p814 notches. The wavy north/south edges and repeated seats are not portals. PDF pages 8/42 identify the room as Collaboratorium, correcting the earlier analysis OCR; internal passage between entrances is not established.',
      { destinationOnly: true, roomIdentity: 'IAB1100', reportPortalIds: ['P05', 'P06'] }),

      LB.region('LB-R03', 'The Green Room', 'room', [
        [348, 275], [437, 276], [441, 324], [432, 331], [412, 334], [350, 333],
      ], ['p850', 'p120', 'p122'],
      'Vertices follow the inset room fill p850, including its slanted southeast corner. PDF pages 8/42 identify the Green Room and place P07 at this corner. This does not use the earlier analysis guessed room name, seat count, or guessed northwest doorway.',
      { destinationOnly: true, reportPortalIds: ['P07'] }),
    ],
    doors: [
      LB.door('LB:P05', ['LB-route-central-south', 'LB-R02'], [[475, 67], [475, 75]],
        ['p665', 'p632', 'p641'],
        'Northwest Collaboratorium threshold: source SVG p665 is a grey opening at x468-476,y67-75; the PDF marks a west-side opening near the top of LB-R02. Door width and entrance elevation are estimates.'),
      LB.door('LB:P06', ['LB-route-central-south', 'LB-R02'], [[475, 225], [475, 235]],
        ['p814', 'p632', 'p641'],
        'Southwest Collaboratorium threshold follows the separate grey p814 notch near (475,230), corroborated by the lower west opening on PDF page 8. Keep it distinct from the northern entrance.'),
      LB.door('LB:P07', ['LB-route-central-south', 'LB-R03'], [[441, 324], [432, 331]],
        ['p850', 'p632'],
        'Green Room southeast threshold follows the room/circulation slant visible in p850/p632. PDF P07 is at this same southeast corner. The wall gap and exact threshold remain draft estimates.'),
    ],
    spines: [
      LB.spine('LB-central-spine', 'LB-route-central-south', [[330, 297], [330, 247], [453, 247], [453, 307], [480, 327], [620, 327]],
        ['p632', 'p897', 'p912', 'p898'], 'Hand-positioned spine through the inset central/south routing strip.'),
      LB.spine('LB-north-spine', 'LB-route-central-south', [[453, 247], [453, 180], [458, 140], [458, 71]],
        ['p632'], 'Narrow corridor west of Collaboratorium; stays east of the unconfirmed open steps.'),
      LB.spine('LB-east-spine', 'LB-route-east', [[635, 282], [635, 262], [648, 233], [684, 145], [694, 142]],
        ['p724'], 'Independent diagonal corridor component. No jump across the uncertain southern boundary.'),
    ],
    candidateLandings: [
      LB.landing('LB-SA', 'stair-A', 'stair', [132, 292], [130, 270], ['p856', 'p83'], ['P21', 'P22'], 'Named Stair A matches the PDF southwest core. Its two portal candidates remain separate observations; this trace does not route through the surrounding service area.'),
      LB.landing('LB-SB', 'stair-B', 'stair', [521, 292], [513, 321], ['p851', 'p310', 'p311', 'p897'], ['P23'], 'PDF identifies Stair B beside the south elevator. Candidate approach follows the southern p897 circulation and stops below its doorway-shaped extension; no flight, landing elevation, or re-entry status is verified.', [[513, 327], [513, 321], [514, 315]]),
      LB.landing('LB-SC', 'stair-C', 'stair', [377, 91], [340, 111], ['p668', 'p384'], ['P24'], 'Stair C identity agrees with the yellow core and PDF. The lower-left opening is a candidate only.'),
      LB.landing('LB-SD', 'stair-D', 'stair', [773, 100], [756, 124], ['p677', 'p679', 'p680', 'p682'], ['P25'], 'PDF identifies northeast core D; service-room circulation around it does not establish public access.'),
      LB.landing('LB-EC', 'elevator-C', 'elevator', [436, 89], [454, 89], ['p670', 'p385', 'p386', 'p632'], ['P26'], 'Blue shaft east of C is preserved separately from stair C. Circulation-side approach is in p632, stopping outside the shaft; served floors, doors, and accessible route remain unverified.', [[458, 89], [454, 89], [449, 89]]),
      LB.landing('LB-EB', 'elevator-B', 'elevator', [478, 294], [456, 294], ['p852', 'p128', 'p409', 'p632'], ['P27'], 'Blue shaft west of B. Candidate approach follows p632 towards its west-side notch near y285 and stops outside the shaft; no elevator service edge is generated.', [[453, 294], [459, 289], [466, 285]]),
      LB.landing('LB-SEXTRA', 'unresolved-extra-northwest', 'stair', [362, 57], [310, 60], ['p626', 'p375', 'p639'], [], 'Extra upper core has an uncertain numeral/letter in the SVG. Preserve PDF synthetic identity without equating it to A-D or asserting a connection to L1.'),
      LB.landing('LB-OS01', 'unresolved-open-stair-LB', 'open-stair', [361, 144], [341, 172], ['p632'], [], 'Step-like hole/detail in p632 near (350,130)-(382,166). Both endpoints and its interpretation require review; no route crosses it.'),
    ],
    excludedFeatures: [
      { reportRegionIds: ['LB-R01'], reason: 'Arrow Innovation Hall has tiered seating and four photographed portal candidates versus two listed entrances/exits. Keep the room in the inventory; do not invent seating traversal or reconcile portals by proximity.', sourceShapeIds: ['p691', 'p660', 'p737', 'p766'], reviewPage: 8 },
      { reportRegionIds: ['LB-R04'], reason: 'Right tiered classroom may occupy a different elevation and relate to L1; no room-interior or cross-floor route is inferred.', sourceShapeIds: ['p795', 'p769', 'p770'], reviewPage: 8 },
      { reportRegionIds: ['LB-R05', 'LB-R06'], reason: 'Main Electrical and Mechanical/Sprinkler Pump are service spaces, excluded from public transit.', sourceShapeIds: ['p644', 'p645', 'p771'], reviewPage: 8 },
      { reportRegionIds: ['LB-U01', 'LB-U02', 'LB-U03'], reason: 'Unresolved curved region, annex and upper strip are not circulation merely because they have light fills.', sourceShapeIds: ['p609', 'p619', 'p715'], reviewPage: 8 },
    ],
  },
  {
    id: 'L1', label: 'Level 1', level: 1, width: 843, height: 367,
    coordinateFrame: 'svg-original-L1',
    sourceFrameId: 'svg-original-L1', geometryBasis: 'svg-traced',
    sourceFile: 'source/Level-1-original.svg',
    sourceSvg: 'Level-1-original.svg', sourceImage: 'Level-1-original.png',
    reviewPages: [7, 39, 40, 41],
    sourceShapeIdConvention: 'one-based-path-ordinal',
    geometryNote: 'Source viewBox 0 0 843 367. The manually placed lobby strip follows the original SVG p921 and excludes the west white region and open stair footprints. Review annotation rectangles are not geometry.',
    regions: [
      L1.region('L1-route-lobby', 'Central lobby and northeast concourse strip', 'lobby', [
        [287, 75], [311, 75], [311, 112], [331, 161], [354, 213],
        [381, 208], [404, 159], [437, 116], [465, 103], [545, 102],
        [620, 105], [628, 100], [635, 102], [642, 112], [675, 127],
        [725, 135], [722, 149], [669, 142], [617, 124], [545, 116],
        [535, 144], [527, 164], [520, 180], [512, 180], [512, 170],
        [509, 170], [509, 163], [514, 163], [516, 145], [527, 135],
        [469, 118], [445, 130], [418, 169], [395, 222], [376, 239],
        [371, 300], [281, 300], [281, 282], [352, 282], [352, 241],
        [309, 223], [289, 174], [287, 132],
      ], ['p921', 'p866', 'p924', 'p1028'],
      'Inset manually traced through the mauve p921 lobby, around the south/east of the triangular open stair, north of the Dark Matter boundary, and south of Brainstorm. A small branch follows p921 east of Dark Matter to its upper east threshold. The white west area, chevron and steps are excluded; no exterior exit arrows become automatic doors.',
      { reportRegionIds: ['L1-C01', 'L1-C02', 'L1-C03'] }),

      L1.region('L1-R01', 'Brainstorm', 'room', [
        [574, 55], [651, 57], [648, 103], [635, 102], [628, 100], [563, 78],
      ], ['p924', 'p289'],
      'Trapezoid follows the visible p924 interior and its slanted south wall, associated with Brainstorm by PDF page 7. The label from the earlier SVG analysis was uncertain; the report supplies identity. The southern notch is retained as a draft doorway.',
      { destinationOnly: true, reportPortalIds: ['P01'] }),

      L1.region('L1-R02', 'Dark Matter', 'room', [
        [485, 159], [509, 159], [509, 170], [504, 235], [453, 235], [471, 187],
      ], ['p1028', 'p183', 'p396'],
      'Inset eastern room surface follows p1028 and preserves the diagonal western partition to the smaller enclosure. The draft doorway is the upper east notch around (509,166), corresponding to PDF P02; steps west of the room are not included.',
      { destinationOnly: true, reportPortalIds: ['P02'] }),
    ],
    doors: [
      L1.door('L1:P01', ['L1-route-lobby', 'L1-R01'], [[628, 100], [635, 102]],
        ['p924', 'p921'], 'Brainstorm southern notch: manually matched p924/p921 edges and PDF page 7 P01. Placement is approximate; no measured width is claimed.'),
      L1.door('L1:P02', ['L1-route-lobby', 'L1-R02'], [[509, 163], [509, 170]],
        ['p1028', 'p921'], 'Dark Matter upper east opening: room p1028 has a notch near (503,163)-(509,170); PDF P02 marks this same boundary. It is not a stair link to another level.'),
    ],
    spines: [
      L1.spine('L1-lobby-spine', 'L1-route-lobby', [[290, 291], [361, 291], [364, 233], [386, 215], [411, 164], [441, 123], [468, 111], [540, 109], [620, 116], [673, 135], [716, 142]],
        ['p921'], 'Manual spine stays in the conservative p921 corridor strip, bypassing the triangular open stair and the central teaching-room wall.'),
      L1.spine('L1-west-spine', 'L1-route-lobby', [[299, 82], [299, 130], [301, 171], [320, 215], [360, 228]],
        ['p921'], 'Vertical/diagonal lobby branch stays east of the white western volume and west of the triangular open stair.'),
      L1.spine('L1-dark-matter-approach', 'L1-route-lobby', [[540, 109], [530, 138], [521, 154], [519, 168]],
        ['p921'], 'Approach branch to Dark Matter east threshold; room is destination-only.'),
    ],
    candidateLandings: [
      L1.landing('L1-SA', 'stair-A', 'stair', [132, 278], [181, 300], ['p1154', 'p1187', 'p1197'], ['P12', 'X11'], 'Southwest yellow core matches PDF Stair A. Exterior X11 is an exit-group observation, not a verified threshold; the adjacent steps remain excluded.'),
      L1.landing('L1-SB', 'stair-B', 'stair', [475, 280], [451, 250], ['p1192', 'p1195', 'p1196', 'p1214'], ['P13', 'X10'], 'South-centre Stair B has an upper entrance candidate and an exterior exit-group observation. No connection to LB or L2 is enabled.'),
      L1.landing('L1-SC', 'stair-C', 'stair', [378, 93], [337, 111], ['p957', 'p962', 'p960'], ['P14'], 'Core C matches the report. Keep its landing candidate distinct from the extra stair above and the open stair below.'),
      L1.landing('L1-SD', 'stair-D', 'stair', [704, 87], [686, 119], ['p909', 'p978', 'p965', 'p964', 'p921'], ['P15', 'X05'], 'Northeast D core with an interior opening candidate and exterior exit-group marker. Approach stays in p921 south of the core and ends before its threshold. Do not use the posted YOU ARE HERE marker as a user location.', [[713, 142], [704, 128], [687, 122]]),
      L1.landing('L1-EC', 'elevator-C', 'elevator', [415, 93], [434, 94], ['p961', 'p214'], ['P16'], 'Blue p961 shaft east of C. A shaft identity is not evidence of served floors, current accessibility or a verified landing.'),
      L1.landing('L1-EB', 'elevator-B', 'elevator', [436, 280], [420, 280], ['p1183', 'p1199'], ['P17'], 'Blue shaft adjacent to B. The sloping surrounding boundaries require local inspection; no automatic transition edge is generated.'),
      L1.landing('L1-SEXTRA', 'unresolved-extra-northwest', 'stair', [375, 59], [337, 53], ['p900', 'p937', 'p948'], ['X03'], 'Separate upper stair, identity unresolved. Similarity to the LB extra core is recorded for review only.'),
      L1.landing('L1-OS01', 'unresolved-open-stair-L1-central', 'open-stair', [377, 160], [382, 209], ['p996', 'p1010', 'p1018', 'p1030'], [], 'Triangular stair-like area below C. The routing strip goes around it; endpoints/elevation remain unverified.'),
      L1.landing('L1-OS02', 'unresolved-open-stair-L1-northwest', 'open-stair', [261, 91], [285, 103], ['p921', 'p228'], [], 'Northwest step-like detail is not treated as continuous lobby circulation.'),
      L1.landing('L1-OS03', 'unresolved-open-stair-L1-southwest', 'open-stair', [232, 277], [256, 288], ['p1190', 'p921'], [], 'Steps east of A are separate from the named core. No cross-floor match is assumed.'),
      L1.landing('L1-OS04', 'unresolved-open-stair-L1-dark-matter', 'open-stair', [413, 215], [394, 215], ['p1058', 'p1075', 'p1090'], [], 'Narrow steps west of the central small room stay outside the draft lobby route.'),
      L1.landing('L1-OS05', 'unresolved-open-stair-L1-east', 'open-stair', [715, 205], [737, 204], ['p196', 'p199', 'p204'], [], 'Step groups on the eastern tiered-classroom boundary do not prove a usable entrance or another-floor connection.'),
    ],
    excludedFeatures: [
      { reportRegionIds: ['L1-U01', 'L1-U02'], reason: 'The large west white footprint and chevron feature can depict a different-height space. Neither becomes walkable lobby floor.', sourceShapeIds: ['p17', 'p225', 'p1011', 'p1013', 'p1014'], reviewPage: 7 },
      { reportRegionIds: ['L1-U03'], reason: 'Curved white region beneath C remains unknown, separate from the adjoining open stair.', sourceShapeIds: ['p921', 'p866'], reviewPage: 7 },
      { reportRegionIds: ['L1-R03', 'L1-R12', 'L1-R13', 'L1-R14', 'L1-R15'], reason: 'Eastern tiered classroom and its ancillary/vestibule areas have uncertain thresholds and internal elevations. No through-route or LB link is inferred.', sourceShapeIds: ['p196', 'p199', 'p204', 'p1069', 'p1091'], reviewPage: 7 },
      { reportRegionIds: ['L1-C04'], reason: 'Southwest circulation is separated from the main trace by stair and vestibule details; it is not bridged across the uncertain stepped boundary.', sourceShapeIds: ['p1201', 'p1206', 'p1208'], reviewPage: 7 },
    ],
  },
];
