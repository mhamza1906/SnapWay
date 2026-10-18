// Project-only connector proposals. Coordinates are in each frozen original
// SVG's viewBox, never the PDF's differently cropped annotation frame.
// A landing lies OUTSIDE its core, at the assumed circulation-side threshold.
// Repeated A–D and B/C labels support identity only. Service, re-entry, exact
// doorway locations and floor heights are deliberately assumptions, not survey.
import { lowerConnectorFloors } from './project-connectors-lower.mjs';

export const PROJECT_CORE_IDS = ['stair-A','stair-B','stair-C','stair-D','elevator-B','elevator-C'];
const corridor = (id, polygon, sourceShapeIds, note) => ({ id, polygon, sourceShapeIds, note });
const path = (id, points, regionIds, sourceShapeIds, note = 'Manually follows the original SVG circulation around room/void boundaries.') => ({ id, points, regionIds, sourceShapeIds, note });
const landing = (floorId, coreId, point, threshold, refs, approachPath, regionIds, attachToRegionIds, note, horizontalStatus = 'assumed') => ({
  id: `${floorId}-project-${coreId}`, coreId, type: coreId.startsWith('stair') ? 'stairs' : 'elevator',
  point, threshold, sourceShapeIds: refs, approachPath, approachRegionIds: regionIds, attachToRegionIds,
  horizontalStatus, note: `${note} Threshold and floor service are project assumptions; no measured height, accessibility or human verification.`,
});
const floor = (floorId, width, height, reviewPage, corridors, paths, landings) => ({
  floorId, width, height, reviewPage, coordinateFrame: `svg-original-${floorId}`,
  evidenceStatus: 'assumed', reviewStatus: 'agent-inspected', corridors, paths, landings, joins: [],
});

const L2 = floor('L2',781,333,6,[
  corridor('L2-project-EC-approach',[[408,60],[425,60],[425,97],[408,97]],['p788','p854'],'Grey circulation east of Elevator C, west of Mission Control. Excludes the shaft and Stair C.'),
  corridor('L2-project-EB-approach',[[408,220],[426,220],[426,269],[414,269],[414,242],[408,239]],['p788','p1206'],'Inset circulation west of Elevator B. The shaft and southern room are excluded.'),
],[],[
  landing('L2','stair-A',[87,246],[[90,242],[90,250]],['p1082','p788'],[],[],[],'West-side core threshold is located, but the adjoining small vestibule is not accepted as public circulation.','unresolved'),
  landing('L2','stair-B',[498,224],[[494,228],[501,228]],['p1081','p788'],[[498,218],[498,224]],['L2-nav-S'],['L2-nav-S'],'North-east threshold faces the south corridor; avoids all central open stairs.'),
  landing('L2','stair-C',[330,99],[[326,94],[333,94]],['p855','p856','p788'],[[330,103],[330,99]],['L2-nav-N'],['L2-nav-N'],'South-west core entrance matches the lower Stair C swing and report P35.'),
  landing('L2','stair-D',[681,96],[[678,89],[685,89]],['p847','p788'],[[681,101],[681,96]],['L2-nav-N'],['L2-nav-N'],'South-west core threshold approaches from the north corridor below the core, matching P36.'),
  landing('L2','elevator-B',[421,248],[[427,244],[427,252]],['p1206','p788'],[[419,220],[419,234],[421,248]],['L2-nav-S','L2-project-EB-approach'],['L2-nav-S'],'West face is the assumed passenger entrance; source depicts a blue shaft but does not resolve its doors.'),
  landing('L2','elevator-C',[412,70],[[407,66],[407,74]],['p854','p788'],[[416,99],[416,86],[412,70]],['L2-nav-N','L2-project-EC-approach'],['L2-nav-N'],'East face is the assumed passenger entrance from the broad grey circulation beside the shaft.'),
]);

const L3 = floor('L3',735,344,5,[
  corridor('L3-project-EC-approach',[[379,55],[396,55],[396,95],[379,95]],['p453','p493'],'Circulation east of Elevator C; neither shaft nor northern room becomes walkable.'),
  corridor('L3-project-A-approach',[[68,216],[78,216],[78,253],[69,253]],['p453','p638'],'Narrow visible circulation west of Stair A, between the core and west enclosure.'),
],[],[
  landing('L3','stair-A',[74,232],[[78,228],[78,236]],['p638','p453'],[[74,215],[74,232]],['L3-nav-S','L3-project-A-approach'],['L3-nav-S'],'West-side landing stays in the narrow circulation beside the core; report P32.'),
  landing('L3','stair-B',[452,212],[[449,218],[455,218]],['p626','p645','p453'],[[452,207],[452,212]],['L3-nav-S'],['L3-nav-S'],'North-east threshold matches the visible north swing, approached from the lower corridor; report P33.'),
  landing('L3','stair-C',[308,95],[[305,87],[312,87]],['p500','p504','p453'],[[308,99],[308,95]],['L3-nav-N'],['L3-nav-N'],'South-west threshold faces the upper corridor and matches report P34.'),
  landing('L3','stair-D',[634,95],[[631,83],[638,83]],['p485','p452'],[[634,97],[634,95]],['L3-nav-N'],['L3-nav-N'],'South-west threshold of the northeast core; report P35. Landing is on the corridor side.'),
  landing('L3','elevator-B',[379,238],[[383,234],[383,242]],['p632','p453'],[[373,212],[373,238],[379,238]],['L3-nav-S'],['L3-nav-S'],'West-face entrance assumed from the narrow blue-shaft notch; remains outside the shaft.'),
  landing('L3','elevator-C',[385,66],[[379,62],[379,70]],['p493','p453'],[[387,97],[387,83],[385,66]],['L3-nav-N','L3-project-EC-approach'],['L3-nav-N'],'East-face entrance assumed. The SVG identifies a shaft but the PDF resolves no elevator portal.'),
]);

const L4 = floor('L4',755,344,4,[
  corridor('L4-project-N',[[180,65],[400,56],[582,50],[582,66],[400,73],[180,83]],['p804','p751'],'North corridor follows its photographed skew above the inner cells and core C, linking the existing west trace.'),
  corridor('L4-project-EC-approach',[[399,57],[420,57],[420,105],[416,119],[399,120]],['p804','p1101'],'Wide circulation east of core C, outside the blue shaft and above the central enclosure.'),
  corridor('L4-project-E',[[575,50],[597,50],[598,112],[597,126],[590,128],[590,127],[580,128],[580,110]],['p751'],'North part of the east passage, ending at its visible transverse wall and doorway.'),
  corridor('L4-project-E-south',[[590,128],[597,126],[597,137],[592,150],[592,207],[600,217],[580,222],[580,132]],['p895'],'South part of the east passage begins only at the visible doorway near (593,128); the rest of the transverse wall is excluded.'),
  corridor('L4-project-S',[[350,219],[419,214],[578,208],[592,208],[592,222],[500,226],[434,230],[412,230],[412,269],[395,269],[395,237],[350,237]],['p895','p994','p991'],'South corridor below the central enclosures and west-side Elevator B approach. Does not cross either central room.'),
  corridor('L4-project-A-approach',[[184,74],[203,74],[207,237],[210,279],[187,289],[187,244],[89,247],[89,238],[185,233]],['p804','p1019'],'Inner west circulation around the west side of the large crossed region, then around the NORTH of Stair A. The solid wall x87–88 separates this approach from the outer west corridor.'),
  corridor('L4-project-A-mouth',[[89,240],[94,240],[94,267],[89,267]],['p804','p1019'],'Narrow circulation west of Stair A but EAST of the continuous dividing wall. Accessible from its north, never directly through the wall.'),
  corridor('L4-project-D-approach',[[590,99],[717,94],[719,105],[592,112]],['p751','p822'],'Corridor below Stair D and its service rooms; no service enclosure is traversed.'),
],[
  path('L4-project-north-spine',[[175,75],[200,74],[300,69],[410,65],[585,59]],['L4-nav-NW','L4-project-N','L4-project-E'],['p804','p751']),
  path('L4-project-east-spine',[[585,59],[588,108],[593,123],[593,129],[590,137],[586,150],[586,216],[480,222],[406,225]],['L4-project-E','L4-project-E-south','L4-project-S'],['p751','p895'],'Walk around the east side of the crossed central region, through the visible corridor doorway near (593,128), then along its south side.'),
  path('L4-project-inner-west-spine',[[195,75],[194,95],[195,150],[199,225],[194,240],[196,280],[180,284]],['L4-project-N','L4-project-A-approach','L4-nav-SW'],['p804'],'Route around the inner west side of the crossed region and east of Stair A service rooms, reaching the southwest cells without crossing the continuous west dividing wall.'),
],[
  landing('L4','stair-A',[91,258],[[94,254],[94,262]],['p1019','p804'],[[194,240],[92,242],[91,258]],['L4-project-A-approach','L4-project-A-mouth'],['L4-project-A-approach'],'West-facing threshold at the visible stair swing; approach from the north along the EAST side of the dividing wall.'),
  landing('L4','stair-B',[484,225],[[480,229],[487,229]],['p991','p895'],[[480,222],[484,225]],['L4-project-S'],['L4-project-S'],'North-east entrance at the visible stair swing, reached around the central excluded region.'),
  landing('L4','stair-C',[324,72],[[321,76],[327,76]],['p841','p846','p804'],[[300,69],[324,69],[324,72]],['L4-project-N'],['L4-project-N'],'North-west swing faces the northern corridor; the stair name is repeated in the PDF.'),
  landing('L4','stair-D',[660,101],[[656,94],[663,94]],['p822','p751'],[[588,108],[610,105],[660,101]],['L4-project-E','L4-project-D-approach'],['L4-project-E'],'South-west entrance of the northeast core; below its service room block.'),
  landing('L4','elevator-B',[408,250],[[413,246],[413,254]],['p994','p895'],[[406,225],[405,242],[408,250]],['L4-project-S'],['L4-project-S'],'West-side shaft entrance assumed from the blue shape and circulation notch. No accessibility claim.'),
  landing('L4','elevator-C',[403,86],[[398,82],[398,90]],['p1101','p804'],[[410,65],[410,86],[403,86]],['L4-project-N','L4-project-EC-approach'],['L4-project-N'],'East-face shaft entrance assumed from the adjacent circulation; the PDF resolves no elevator threshold.'),
]);

const L5 = floor('L5',702,335,3,[
  corridor('L5-project-NW',[[67,39],[79,39],[79,45],[183,43],[183,87],[186,87],[186,94],[183,94],[183,103],[173,103],[173,58],[73,60],[67,60]],['p592','p593','p610'],'Connects the west trace around the north of the west inner cells and through the visible door mouth at (184,91). The small crossed west region and the solid wall below that mouth remain excluded.'),
  corridor('L5-project-N',[[173,44],[294,41],[390,40],[390,52],[294,54],[183,59],[183,97],[173,97]],['p592','p610'],'North corridor above the inner cells and Stair C. The PDF does not resolve core doors; the visible swing supplies an estimated threshold.'),
  corridor('L5-project-EC-approach',[[332,86],[362,84],[363,52],[378,52],[378,113],[332,113]],['p610','p649'],'L-shaped circulation around the east and south of core C, joining the existing north/central traces.'),
  corridor('L5-project-EB-approach',[[347,201],[367,201],[365,243],[347,243]],['p610','p776'],'Inset circulation west of Elevator B; no shaft or adjoining southern cell is walkable.'),
  corridor('L5-project-NE',[[378,40],[575,35],[667,33],[667,47],[380,54]],['p610','p614','p615'],'Long northern circulation above the eastern inner cells; does not enter the large crossed region.'),
  corridor('L5-project-D-east',[[662,41],[667,41],[667,93],[662,93]],['p610','p629'],'Inset east perimeter approach around the northeast stair core, west of the outer-room wall.'),
  corridor('L5-project-D-south',[[544,84],[663,78],[667,79],[667,93],[544,98]],['p610','p629'],'Circulation south of core D; routed around the core east side rather than through its service rooms.'),
],[
  path('L5-project-west-link',[[67,48],[100,50],[176,50],[178,91],[188,91],[190,96]],['L5-nav-W','L5-project-NW','L5-project-N','L5-nav-N'],['p592','p593','p610']),
  path('L5-project-core-C-loop',[[190,96],[320,96],[369,96],[369,48],[294,49],[176,50]],['L5-nav-N','L5-project-EC-approach','L5-project-N'],['p610','p649','p651'],'Circulation loops around core C; no core interior or central void shortcut.'),
  path('L5-project-northeast-spine',[[369,48],[500,45],[590,42],[665,42],[665,86],[608,86]],['L5-project-N','L5-project-NE','L5-project-D-east','L5-project-D-south'],['p610','p614','p615','p629']),
],[
  landing('L5','stair-A',[66,229],[[70,226],[70,232]],['p790','p619'],[[64,229],[66,229]],['L5-nav-W'],['L5-nav-W'],'West-facing swing of core A, using the narrow source aisle outside the yellow shaft.'),
  landing('L5','stair-B',[433,202],[[431,206],[436,206]],['p769','p784','p610'],[[433,197],[433,202]],['L5-nav-S'],['L5-nav-S'],'North-east swing faces the existing southern corridor.'),
  landing('L5','stair-C',[294,50],[[291,54],[297,54]],['p651','p610'],[[294,49],[294,50]],['L5-project-N'],['L5-project-N'],'North-west swing faces the north corridor, unlike the lower floors south-facing C entrance.'),
  landing('L5','stair-D',[608,86],[[604,78],[611,78]],['p629','p610'],[[620,86],[608,86]],['L5-project-D-south'],['L5-project-D-south'],'South-west core threshold, reached from the east perimeter corridor.'),
  landing('L5','elevator-B',[363,225],[[367,221],[367,229]],['p776','p610'],[[350,198],[357,208],[357,225],[363,225]],['L5-nav-S','L5-project-EB-approach'],['L5-nav-S'],'West face is an assumed elevator entrance; stays outside the blue shaft.'),
  landing('L5','elevator-C',[367,65],[[362,61],[362,69]],['p649','p610'],[[369,96],[369,78],[367,65]],['L5-project-EC-approach'],['L5-project-EC-approach'],'East face is an assumed passenger entrance from circulation; served floors remain an explicit project assumption.'),
]);

// Corrections are scoped to the integrated project. The standalone draft and
// its historical tests retain their original data for comparison.
L4.regionOverrides = [{ id: 'L4-nav-SW', polygon: [[90,278],[188,278],[188,288.128],[90,292.44]], sourceShapeIds: ['p804'], note: 'Keep the south corridor east of the solid x87–88 wall; connect via the inner west spine.' }];
L4.removeDoorIds = ['L4:join-W-SW'];
L5.regionOverrides = [{ id: 'L5-nav-W', polygon: [[61.0325,37],[73,37],[73,209],[68,214],[68,249],[73,253],[73,274],[54.515,274]], sourceShapeIds: ['p592','p619'], note: 'Narrow the original draft aisle beside Stair A so its yellow core from x70 is excluded.' }];

export const upperConnectorFloors = [L2,L3,L4,L5];
export const projectConnectorFloors = [...lowerConnectorFloors,...upperConnectorFloors];
export const projectConnectorPolicy = {
  projectId: 'sam-ibrahim', evidenceStatus: 'assumed', reviewStatus: 'agent-inspected',
  coreIds: PROJECT_CORE_IDS, adjacentFloors: ['LB','L1','L2','L3','L4','L5'],
  assumedService: 'Each repeated named core A–D and elevator B/C serves the six depicted floors. Adjacent-floor transitions only.',
  accessibility: 'unknown', fieldVerified: false,
  excluded: ['Unlabelled extra northwest stair','All open stairs/terraces','Cloud and Conveyor interior floor relationships','Roof gardens and crossed void regions'],
};
