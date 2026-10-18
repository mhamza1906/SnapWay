// Coordinates below are authored in the ORIGINAL vectorizer SVG viewBox, in
// SVG units. They are NOT rectangles generated from the PDF inventory centres.
// pN references use the pipeline compactSvg path-first enumeration. Room names
// and depiction identities come from the PDF; geometry comes from SVG paths.
// Threshold positions/widths are approximate, so every door is draft/assumed.
const norm = (p, w, h) => [p[0] / w, p[1] / h];
function floor(id, width, height, page) {
  const f = { id, label: `Level ${id.slice(1)}`, level: Number(id.slice(1)), width, height,
    sourceFrameId: `svg-original-${id}`, coordinateFrame: `svg-original-${id}`,
    sourceFile: `source/Level-${id.slice(1)}-original.svg`, reviewPage: page,
    geometryBasis: 'svg-traced', regions: [], doors: [], spines: [], candidateLandings: [],
    evidenceNote: 'Manual simplified wall/aisle trace from original SVG, compared with the report floor image. No metric scale or field validation.' };
  const region = (rid, label, kind, points, shapeIds, note = '') => {
    f.regions.push({ id: rid, label, kind, polygon: points.map(p => norm(p,width,height)),
      geometryBasis:'svg-traced', sourceShapeIds: shapeIds, sourceFrameId:f.sourceFrameId,
      reviewPage:page, evidenceNote: note || f.evidenceNote });
  };
  const door = (pid, a, b, p, q, shapeIds, note = '', openingType = 'door') => {
    f.doors.push({ id: `${id}:${pid}`, regionIds:[a,b], segment:[norm(p,width,height),norm(q,width,height)],
      status:'draft', openingType, sourceShapeIds:shapeIds, sourceFrameId:f.sourceFrameId,
      reviewPage:page, evidenceNote:note || 'Opening candidate compared in SVG and report; position and width are manually approximated. Not field verified.' });
  };
  const join = (pid,a,b,p,q,shapeIds) => door(pid,a,b,p,q,shapeIds,'Manually traced continuous SVG circulation at a partition seam; an artificial graph partition, not a room doorway.','decomposition-join');
  return { f, region, door, join };
}

function level2() {
  const {f,region:r,door:d,join:j} = floor('L2',781,333,6);
  r('L2-nav-N','North circulation and Cloud–Keystone passage','corridor',[[143,80],[270,80],[270,94],[410,94],[410,80],[640,80],[640,90],[778,90],[778,108],[300,108],[270,101],[253,97],[230,92],[193,94],[190,108],[166,108],[166,160],[159,180],[170,210],[178,220],[178,232],[150,232],[150,108],[143,108]],['p788','p789','p175','p182','p247','p885'],'The lower north edge skirts above the Keystone rim; the Cloud–Keystone neck narrows around its sloping west wall. These conservative circulation strips do not include either tiered room.');
  r('L2-nav-E','East circulation','corridor',[[755,108],[778,108],[778,210],[755,210]],['p788','p273','p271']);
  r('L2-nav-S','South circulation and Stage approach','corridor',[[178,225],[220,226],[275,224],[315,219],[365,215],[525,210],[778,210],[778,225],[550,225],[550,230],[410,230],[410,232],[285,232],[285,244],[190,244],[190,310],[178,310]],['p788','p609','p617'],'The upper edge follows below the curved Keystone boundary; seating and the central stair flights remain outside circulation.');
  j('join-N-E','L2-nav-N','L2-nav-E',[760,108],[772,108],['p788']);
  j('join-E-S','L2-nav-E','L2-nav-S',[760,210],[772,210],['p788']);
  j('join-W-S','L2-nav-N','L2-nav-S',[178,226],[178,232],['p788']);
  r('L2-R01','The Corner Shop','room',[[28,13],[143,13],[143,108],[28,108]],['p795','p90']);
  r('L2-R02','The Spot','room',[[155,12],[255,12],[255,80],[155,80]],['p794','p89']);
  r('L2-R03','Mission Control','room',[[427,11],[521,11],[521,80],[427,80]],['p792','p61']);
  r('L2-R04','The Portal','room',[[523,10],[569,10],[569,80],[523,80]],['p791','p84']);
  r('L2-R05','The Living Room','room',[[571,10],[639,10],[639,80],[571,80]],['p790','p82']);
  r('L2-R06','The Cloud (terminal entrances only)','room',[[32,108],[150,108],[150,220],[35,220]],['p896','p184','p185'], 'Tiered room footprint; both doors remain distinct. Interior traversal intentionally absent. L3 depiction is excluded.');
  r('L2-R07','The Keystone (terminal entrance only)','room',[[195,108],[260,108],[365,176],[365,210],[185,210],[166,190]],['p885','p247'],'Simplified tiered-room footprint. Only southeast opening is placed; north entrance remains in review inventory.');
  r('L2-R08','The Conveyor (terminal entrances only)','room',[[565,108],[755,108],[755,210],[526,210]],['p888','p890'],'Tiered footprint, no internal transit; no connection to its L3 depiction.');
  r('L2-R09','The Stage','room',[[190,244],[285,244],[285,310],[190,310]],['p1090','p734']);
  r('L2-R10','Boundary','room',[[550,225],[664,225],[664,301],[550,301]],['p1063','p627']);
  r('L2-R11','Rhythm','room',[[664,225],[778,225],[778,298],[664,298]],['p1062','p609']);
  d('P01','L2-R01','L2-nav-N',[143,98],[143,104],['p795','p90']);
  d('P02','L2-R02','L2-nav-N',[246,80],[252,80],['p869','p870','p69']);
  d('P03','L2-R03','L2-nav-N',[429,80],[435,80],['p61','p238']);
  d('P04','L2-R04','L2-nav-N',[525,80],[531,80],['p873','p59']);
  d('P05','L2-R05','L2-nav-N',[573,80],[579,80],['p867','p57']);
  d('P06','L2-R06','L2-nav-N',[150,110],[150,116],['p177','p905','p179']);
  d('P07','L2-R06','L2-nav-N',[150,213],[150,219],['p173','p1056','p183']);
  d('P09','L2-R07','L2-nav-S',[355,210],[363,210],['p885','p247']);
  d('P10','L2-R08','L2-nav-N',[744,108],[752,108],['p888','p890']);
  d('P11','L2-R08','L2-nav-S',[744,210],[752,210],['p888','p890']);
  d('P12','L2-R09','L2-nav-S',[190,246],[190,253],['p1100','p652','p227']);
  d('P13','L2-R10','L2-nav-S',[552,225],[558,225],['p1063','p627']);
  d('P14','L2-R10','L2-nav-S',[654,225],[662,225],['p1067','p626','p628']);
  d('P15','L2-R11','L2-nav-S',[672,225],[680,225],['p1073','p632']);
  d('P16','L2-R11','L2-nav-S',[768,225],[776,225],['p1062','p609']);
  for(const candidate of f.doors.filter(d=>['L2:P02','L2:P06','L2:P07'].includes(d.id))) {
    candidate.status='candidate';
    candidate.evidenceNote += ' The unchanged pipeline did not attach a corridor branch at this approximate threshold. Retained for review; no route edge is accepted.';
  }
  const corner=f.doors.find(d=>d.id==='L2:P01');
  corner.status='candidate';
  corner.evidenceNote += ' The source-correct north boundary above the Keystone rim leaves this doorway without a validated connection to the eastern corridor in the unchanged graph builder. Source-preserving circulation partitions do not resolve it; no room-crossing shortcut or arbitrary edge is accepted.';
  const keystone=f.doors.find(d=>d.id==='L2:P09');
  keystone.status='candidate';
  keystone.evidenceNote += ' Source comparison leaves the southeast threshold location unresolved; the corridor follows below the actual curved seating boundary and no connection is forced.';
  return f;
}

function level3() {
  const {f,region:r,door:d,join:j} = floor('L3',735,344,5);
  r('L3-nav-N','Upper corridor','corridor',[[150,77],[241,77],[241,90],[420,90],[420,84],[467,84],[467,80],[600,80],[600,90],[715,90],[715,103],[150,103]],['p453','p452']);
  r('L3-nav-E','East corridor','corridor',[[692,103],[715,103],[715,219],[692,219]],['p452']);
  r('L3-nav-S','Lower corridor with southern recess','corridor',[[35,210],[174,210],[174,200],[692,200],[692,219],[715,219],[715,226],[480,226],[480,215],[385,215],[385,294],[342,294],[342,227],[166,227],[166,220],[35,220]],['p453'],'The central terrace and both open stairs are outside this trace. East perimeter is the only north–south connection here.');
  j('join-N-E','L3-nav-N','L3-nav-E',[698,103],[710,103],['p452']);
  j('join-E-S','L3-nav-E','L3-nav-S',[692,204],[692,214],['p452','p453']);
  r('L3-R01','The Hive','room',[[38,11],[150,11],[150,103],[36,103]],['p462','p166']);
  r('L3-R02','Maples (lettering uncertain)','room',[[151,11],[241,11],[241,77],[151,77]],['p460','p163']);
  r('L3-R05','Unlabelled narrow upper room','room',[[421,9],[467,9],[467,84],[421,84]],['p457','p25']);
  r('L3-R06','The … Shop (name uncertain)','room',[[467,7],[600,7],[600,80],[467,80]],['p454','p157']);
  r('L3-R08','The Conveyor (L3 depiction; terminal only)','room',[[550,103],[692,103],[692,200],[543,200]],['p527','p552'],'No interior connections between entrances; elevations and relationship to L2 remain unresolved.');
  r('L3-R18','Unlabelled southeast room 1','room',[[496,226],[604,226],[604,292],[496,292]],['p671','p633']);
  r('L3-R19','Unlabelled southeast room 2','room',[[604,226],[715,226],[715,289],[604,289]],['p637','p100']);
  d('P02','L3-R01','L3-nav-N',[150,91],[150,98],['p165','p524']);
  d('P03','L3-R02','L3-nav-N',[232,77],[239,77],['p163']);
  d('P06','L3-R05','L3-nav-N',[423,84],[430,84],['p23','p516']);
  d('P07','L3-R06','L3-nav-N',[469,80],[477,80],['p157','p23']);
  d('P08','L3-R06','L3-nav-N',[582,80],[591,80],['p157']);
  d('P09','L3-R08','L3-nav-N',[682,103],[690,103],['p527','p93']);
  d('P10','L3-R08','L3-nav-S',[546,200],[554,200],['p527','p552']);
  d('P11','L3-R08','L3-nav-S',[682,200],[690,200],['p527','p552']);
  d('P21','L3-R18','L3-nav-S',[500,226],[508,226],['p671','p633']);
  d('P22','L3-R18','L3-nav-S',[594,226],[602,226],['p671','p633']);
  d('P23','L3-R19','L3-nav-S',[606,226],[614,226],['p637','p100']);
  d('P24','L3-R19','L3-nav-S',[705,226],[713,226],['p637','p100']);
  return f;
}

function level4() {
  const {f,region:r,door:d,join:j} = floor('L4',755,344,4);
  // The source west wall slopes eastward. The same explicit wall trace is used
  // for each room threshold and corridor edge, rather than an aisle-offset x.
  const wx = y => 66.7 + 0.0385*y;
  r('L4-nav-W','West corridor','corridor',[[wx(84),84],[88,84],[88,278],[wx(278),278]],['p804']);
  r('L4-nav-NW','Northwest corridor','corridor',[[wx(84),70],[186,65],[186,83],[88,88],[88,84],[wx(84),84]],['p804']);
  const sy = x => 296.4 - 0.044*x;
  r('L4-nav-SW','Southwest corridor','corridor',[[wx(278),278],[188,278],[188,sy(188)],[wx(278),sy(wx(278))]],['p804']);
  j('join-NW-W','L4-nav-NW','L4-nav-W',[77,84],[85,84],['p804']);
  j('join-W-SW','L4-nav-W','L4-nav-SW',[79,278],[86,278],['p804']);
  // Individually authored source-cell outlines leave partition gaps between
  // cells. Only the visible door gap is allowed to connect to circulation.
  const west = [
    ['L4-R31','P029',[[40,89],[wx(87),87],[wx(105),105],[41,106]],90.5,['p468','p864']],
    ['L4-R32','P030',[[41,110],[wx(109),109],[wx(127.5),127.5],[41.5,128]],123.5,['p474','p887']],
    ['L4-R33','P031',[[42,133],[wx(130),130],[wx(148),148],[43,150]],133.5,['p487','p902']],
    ['L4-R34','P032',[[43,154],[wx(152),152],[wx(170),170],[44,171]],166.5,['p489','p917']],
    ['L4-R35','P033',[[44,175],[wx(173),173],[wx(192),192],[44.5,192.5]],188,['p492','p939']],
    ['L4-R36','P034',[[45,196],[wx(195),195],[wx(213),213],[45.5,214]],209,['p495','p950']],
    ['L4-R37','P035',[[46,217],[wx(216),216],[wx(234),234],[47,234.5]],230,['p499','p970']],
    ['L4-R38','P036',[[47,240],[wx(237),237],[wx(255),255],[47.5,256]],240.5,['p504','p997']],
    ['L4-R39','P037',[[48,260],[wx(258),258],[wx(277),277],[49,277]],273,['p505','p1031']],
  ];
  for(const [id,pid,poly,y,refs] of west){
    r(id,`${id} west perimeter enclosure`,'room',poly,refs,'Wall and cell dividers manually traced from the original SVG; door position follows the visible swing gap. Source wall thickness is approximate.');
    d(pid,id,'L4-nav-W',[wx(y-2.25),y-2.25],[wx(y+2.25),y+2.25],refs);
  }
  // Source p1077/p1075/p1074/p1071 are separate cells, not equal-width boxes.
  const south = [
    ['L4-R62','P061',97,118,101,317,['p655','p1077']],
    ['L4-R63','P062',121,141,137,315.5,['p654','p1075']],
    ['L4-R64','P063',144,164,148,314.5,['p653','p1074']],
    ['L4-R65','P064',167,188,184,313,['p652','p1071']],
  ];
  for(const [id,pid,a,b,x,bottom,refs] of south){
    r(id,`${id} south perimeter enclosure`,'room',[[a,sy(a)],[b,sy(b)],[b,bottom],[a,bottom+0.5]],refs);
    d(pid,id,'L4-nav-SW',[x-2.5,sy(x-2.5)],[x+2.5,sy(x+2.5)],refs);
  }
  return f;
}

function level5() {
  const {f,region:r,door:d,join:j} = floor('L5',702,335,3);
  // The original west wall slopes westward by about six source units. Room
  // boundaries and thresholds use that wall, not a fixed line inside the aisle.
  const wx = y => 62.05 - 0.0275*y;
  r('L5-nav-W','West corridor','corridor',[[wx(37),37],[73,37],[73,274],[wx(274),274]],['p592','p619']);
  r('L5-nav-SW','Southwest corridor','corridor',[[wx(274),274],[162,274],[162,286],[wx(274),289]],['p592','p619']);
  j('join-W-SW','L5-nav-W','L5-nav-SW',[63,274],[71,274],['p592']);
  const west = [
    ['L5-R22','P021',[[35,42],[wx(41),41],[wx(59),59],[34,59]],55.5,['p481','p623','p648']],
    ['L5-R23','P022',[[34,64],[wx(62),62],[wx(80),80],[33.5,80.5]],75.5,['p441','p678']],
    ['L5-R24','P023',[[33.5,84],[wx(83),83],[wx(101),101],[33,101]],96.5,['p489','p698']],
    ['L5-R25','P024',[[33,106],[wx(104),104],[wx(122),122],[32.5,122]],117,['p493','p713']],
    ['L5-R26','P025',[[32.5,126],[wx(125),125],[wx(142.5),142.5],[32,143]],138,['p495','p728']],
    ['L5-R27','P026',[[32,147],[wx(145),145],[wx(163),163],[31.5,163.5]],159,['p497','p735']],
    ['L5-R28','P027',[[31.5,167],[wx(166),166],[wx(184),184],[31,184]],179.5,['p498','p746']],
    ['L5-R29','P028',[[31,188],[wx(187),187],[wx(204),204],[30.5,204]],200,['p503']],
    ['L5-R30','P029',[[30.5,210],[wx(207.5),207.5],[wx(224.5),224.5],[30.5,225]],215.5,['p505']],
    ['L5-R31','P030',[[30.5,229],[wx(228),228],[wx(245),245],[29.5,245]],236.5,['p506']],
    ['L5-R32','P031',[[29.5,251],[wx(248.5),248.5],[wx(266),266],[29.5,266]],256.5,['p507']],
  ];
  for(const [id,pid,poly,y,refs] of west){
    r(id,`${id} west perimeter enclosure`,'room',poly,refs,'Individual source-cell outline with partition gaps; doorway follows its visible source swing, including the different lower three gap positions.');
    d(pid,id,'L5-nav-W',[wx(y-2),y-2],[wx(y+2),y+2],refs);
  }
  // Independent north/central source trace. It remains disconnected from the
  // west trace until the intervening complicated source geometry is reviewed.
  // Three short north-edge recesses follow visible doorway mouths only.
  r('L5-nav-N','North corridor below inner cells','corridor',[[185,86.5],[191,86.5],[191,88],[217,88],[217,87],[222,87],[222,88],[268,88],[268,86],[274,86],[274,88],[332,88],[332,105],[185,105]],['p610','p684','p685','p683']);
  r('L5-nav-C','Central spine west of isolated room','corridor',[[308,105],[332,105],[332,157],[378,157],[378,187],[308,187]],['p610']);
  r('L5-nav-S','South corridor above Stair B','corridor',[[308,187],[523,187],[523,203],[378,203],[378,207],[308,207]],['p610']);
  j('join-N-C','L5-nav-N','L5-nav-C',[311,105],[329,105],['p610']);
  j('join-C-S','L5-nav-C','L5-nav-S',[315,187],[330,187],['p610']);
  r('L5-R58','L5-R58 west of Stair C','room',[[187,58],[213.5,57.5],[213,85.5],[191,86.5],[185,86.5],[185,80],[186.5,58]],['p658','p684']);
  r('L5-R59','L5-R59 west of Stair C','room',[[217,57.5],[233.5,57],[232.5,85.5],[222,87],[217,87],[216.5,78.5]],['p657','p685'],'Narrow source cell traced inside its two actual partitions, with a short mouth at the southwest doorway; no inclusion of adjacent cells.');
  r('L5-R61','L5-R61 west of Stair C','room',[[253,57],[273.5,56.5],[274,78],[274,86],[268,86],[252,85]],['p654','p683']);
  r('L5-R68','Isolated central enclosure','room',[[332,114],[378,114],[378,157],[332,157]],['p331','p714']);
  d('P058','L5-R58','L5-nav-N',[185.5,86.5],[190.5,86.5],['p684','p63']);
  d('P059','L5-R59','L5-nav-N',[217.5,87],[221.5,87],['p685','p147']);
  d('P061','L5-R61','L5-nav-N',[268.5,86],[273.5,86],['p683','p310']);
  d('P067','L5-R68','L5-nav-C',[332,147.5],[332,151.5],['p731','p101']);
  return f;
}

export const upperFloors = [level2(),level3(),level4(),level5()];
