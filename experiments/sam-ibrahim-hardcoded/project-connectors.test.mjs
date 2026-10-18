import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROJECT_CORE_IDS, projectConnectorFloors, projectConnectorPolicy } from './data/project-connectors.mjs';
import { floors } from './model.mjs';
import { inspectSvgSource } from './svg-tools.mjs';

function contains(point, polygon) {
  let result = false;
  for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[j],b=polygon[i];
    const cross=(point[0]-a[0])*(b[1]-a[1])-(point[1]-a[1])*(b[0]-a[0]);
    if(Math.abs(cross)<1e-7 && point.every((v,k)=>v>=Math.min(a[k],b[k])-1e-7 && v<=Math.max(a[k],b[k])+1e-7)) return true;
    if((b[1]>point[1])!==(a[1]>point[1]) && point[0]<(a[0]-b[0])*(point[1]-b[1])/(a[1]-b[1])+b[0]) result=!result;
  }
  return result;
}

test('project allocates six named cores on each source frame without inventing open-stair matches',()=>{
  assert.deepEqual(projectConnectorFloors.map(f=>f.floorId),['LB','L1','L2','L3','L4','L5']);
  const ids=new Set();
  for(const f of projectConnectorFloors){
    assert.equal(f.coordinateFrame,`svg-original-${f.floorId}`);
    assert.deepEqual(f.landings.map(l=>l.coreId).sort(),[...PROJECT_CORE_IDS].sort());
    for(const l of f.landings){
      assert(!ids.has(l.id));ids.add(l.id);
      assert(['assumed','unresolved'].includes(l.horizontalStatus));
      assert(l.threshold.length===2);
      assert.notDeepEqual(l.point,l.threshold[0]);
      assert.notDeepEqual(l.point,l.threshold[1]);
      if(l.horizontalStatus==='assumed') assert.deepEqual(l.approachPath.at(-1),l.point);
    }
  }
  assert.equal(ids.size,36);
  assert.equal(projectConnectorPolicy.accessibility,'unknown');
  assert.equal(projectConnectorPolicy.fieldVerified,false);
  assert(projectConnectorPolicy.excluded.includes('All open stairs/terraces'));
});

test('connector geometry refers to original SVG shapes and stays in their source coordinate bounds',()=>{
  for(const f of projectConnectorFloors){
    const source=inspectSvgSource(fs.readFileSync(new URL(`./source/Level-${f.floorId.slice(1)}-original.svg`,import.meta.url),'utf8'));
    assert.equal(source.width,f.width);assert.equal(source.height,f.height);
    const ids=new Set(source.shapes.map(s=>s.id));
    for(const item of [...f.corridors,...f.landings,...f.paths,...(f.regionOverrides||[])]){
      assert(item.sourceShapeIds.length>0);
      for(const id of item.sourceShapeIds) assert(ids.has(id),`${f.floorId}: missing source ${id}`);
      const points=item.polygon||item.points||[item.point,...item.threshold,...item.approachPath];
      for(const p of points) assert(p.every(Number.isFinite)&&p[0]>=0&&p[0]<=f.width&&p[1]>=0&&p[1]<=f.height,`${f.floorId} ${item.id} point ${p}`);
    }
  }
});

test('every proposed approach spine stays in authored circulation including project-only wall corrections',()=>{
  for(const f of projectConnectorFloors){
    const sourceFloor=floors.find(x=>x.id===f.floorId);
    const polygons=[...sourceFloor.regions.filter(r=>['corridor','lobby'].includes(r.kind)).map(r=>f.regionOverrides?.find(o=>o.id===r.id)?.polygon||r.polygon.map(([x,y])=>[x*f.width,y*f.height])),...f.corridors.map(r=>r.polygon)];
    for(const p of [...f.paths,...f.landings.filter(l=>l.horizontalStatus==='assumed').map(l=>({id:l.id,points:l.approachPath}))]){
      for(let i=1;i<p.points.length;i++){
        const a=p.points[i-1],b=p.points[i],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])*2));
        for(let j=0;j<=n;j++){
          const point=a.map((v,k)=>v+(b[k]-v)*j/n);
          assert(polygons.some(poly=>contains(point,poly)),`${f.floorId} ${p.id} leaves authored circulation at ${point}`);
        }
      }
    }
  }
  const l4=projectConnectorFloors.find(f=>f.floorId==='L4');
  assert(l4.removeDoorIds.includes('L4:join-W-SW'));
  const sw=l4.regionOverrides.find(r=>r.id==='L4-nav-SW');
  assert(sw.polygon.every(p=>p[0]>=90),'southwest corridor cannot jump through the solid x87–88 wall');
});
