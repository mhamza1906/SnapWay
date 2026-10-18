// Project-only corrections from the frozen original Level 2 SVG, inspected
// after the user pointed out its visible door swings. Units are SVG units.
// These are agent-inspected assumptions, not measured or human-reviewed doors.
export function refineLevel2Openings(floor) {
  if (floor.id !== 'L2') return floor;
  const f = structuredClone(floor);
  const normalized = points => points.map(([x,y]) => [x/f.width,y/f.height]);
  const region = (id, polygon, refs, note) => Object.assign(f.regions.find(r=>r.id===id), {
    polygon: normalized(polygon), sourceShapeIds: refs, evidenceNote: note,
  });
  region('L2-R02', [[155,12],[255,12],[255,79],[155,79]], ['p794','p869','p69'],
    'South-east door swing ends near (247,79)-(254,78); south boundary approximated at y79. Project-only source correction.');
  region('L2-R06', [[32,108],[148,108],[148,118],[151,211],[151,220],[35,220]], ['p896','p177','p905','p173','p1056','p183'],
    'East wall follows the source slope; distinct upper and lower east openings remain terminal destinations with no route through tiered seating.');
  region('L2-R07', [[193,98],[231,96],[253,102],[304,150],[372,197],[367,210],[343,213],[278,220],[215,223],[182,217],[164,180]], ['p885','p247'],
    'Outer tiered-room boundary including the north entrance vestibule and curved south rim. Door swings at the north vestibule and south rim are separate terminals; no internal transit or inter-floor shortcut.');
  f.regions.find(r=>r.id==='L2-R07').label='The Keystone (terminal entrances only)';
  region('L2-nav-N', [[143,79],[270,79],[270,94],[410,94],[410,80],[640,80],[640,90],[778,90],[778,108],[300,108],[270,101],[253,95],[231,90],[189,92],[158,180],[177,220],[178,232],[151,232],[151,211],[148,118],[148,108],[143,108]], ['p788','p789','p247','p885','p905','p1056'],
    'Source circulation above Keystone and between Cloud and Keystone. The narrow north strip and sloping west passage exclude the tiered room and its vestibule.');
  // Short strips meet the actual room boundary instead of leaving a geometry
  // gap between a door and the corridor. They do not extend into the rooms.
  const strip = (id,polygon,refs,note) => f.regions.push({id,label:id,kind:'corridor',polygon:normalized(polygon),geometryBasis:'svg-traced',sourceFrameId:f.sourceFrameId,sourceShapeIds:refs,reviewPage:6,evidenceNote:note});
  strip('L2-project-keystone-north-door',[[193,98],[231,96],[231,90],[189,92]],['p788','p885','p247'],'North corridor reaches the visible north-vestibule threshold.');
  strip('L2-project-keystone-south-door',[[278,220],[343,213],[343,220],[278,227]],['p788','p885','p247'],'South corridor reaches the visible curved-rim threshold; stays below the seating boundary.');
  const door = (id,segment,refs,note) => {
    const d=f.doors.find(d=>d.id===id);
    Object.assign(d,{status:'draft',segment:normalized(segment),sourceShapeIds:refs,evidenceNote:`${note} Manually approximated from the original SVG after user source review; physical access and width remain unverified.`});
  };
  door('L2:P01',[[143,98],[143,104]],['p795','p90','p788'],'East-side Corner Shop threshold adjoining the north-west corridor.');
  door('L2:P02',[[247,79],[254,79]],['p869','p870','p69'],'The Spot south-east door swing.');
  door('L2:P06',[[148,110],[148,116]],['p177','p905','p179'],'Cloud upper east opening.');
  // Match the sloping room wall exactly at the lower east opening.
  door('L2:P07',[[151,213],[151,219]],['p173','p1056','p183'],'Cloud lower east opening.');
  const southY=x=>220-(x-278)*7/65;
  door('L2:P09',[[307,southY(307)],[317,southY(317)]],['p885','p247'],'Keystone south-rim swing near x307–317; replaces the earlier misplaced x355 threshold.');
  const northY=x=>98-(x-193)*2/38;
  f.doors.push({id:'L2:P08',regionIds:['L2-R07','L2-project-keystone-north-door'],segment:normalized([[200,northY(200)],[208,northY(208)]]),status:'draft',openingType:'door',sourceShapeIds:['p885','p247'],sourceFrameId:f.sourceFrameId,reviewPage:6,evidenceNote:'Visible swing on the north vestibule boundary at x200–208. Approximate agent-inspected threshold; no interior connection to the south entrance.'});
  return f;
}
