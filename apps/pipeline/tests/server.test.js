import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
let server;const base='http://127.0.0.1:5174';
before(async()=>{server=spawn(process.execPath,['server/index.js'],{env:{...process.env,APP_ENV:'dev',PORT:'5174',AI_PROVIDER:'openai',OPENAI_MODEL:'gpt-6.1-sol',OPENAI_API_KEY:'server-test-key'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Test server startup timed out')),15000);server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Test server exited ${code}`));});server.stdout.on('data',data=>{if(data.toString().includes('map-authoring pipeline')){clearTimeout(timeout);resolve();}});});});
after(async()=>{if(server&&!server.killed){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}});
test('health endpoint never returns credentials',async()=>{const r=await fetch(base+'/api/health');const data=await r.json();assert.equal(r.status,200);assert.equal(data.provider,'OpenAI');assert.equal(data.model,'gpt-6.1-sol');assert.equal(data.configured,true);assert.equal(data.environment,'dev');assert.deepEqual(Object.keys(data).sort(),['configured','environment','imageModel','model','ok','provider']);assert.deepEqual(Object.keys(data.imageModel).sort(),['configured','model','size']);assert.ok(!JSON.stringify(data).includes('server-test-key'));});
test('upload applies EXIF rotation and records normalized dimensions',async()=>{const bytes=await sharp({create:{width:80,height:40,channels:3,background:'#eeeeee'}}).jpeg().withMetadata({orientation:6}).toBuffer();const form=new FormData();form.append('image',new Blob([bytes],{type:'image/jpeg'}),'rotated.jpg');const r=await fetch(base+'/api/normalize',{method:'POST',body:form});const data=await r.json();assert.equal(r.status,200);assert.equal(data.width,40);assert.equal(data.height,80);assert.equal(data.originalWidth,80);assert.equal(data.normalized,true);const normalized=await sharp(Buffer.from(data.dataUrl.split(',')[1],'base64')).metadata();assert.equal(normalized.width,40);assert.equal(normalized.orientation,undefined);});
test('fake image uploads and malformed project schemas are rejected',async()=>{const form=new FormData();form.append('image',new Blob(['not an image'],{type:'image/png'}),'bad.png');assert.equal((await fetch(base+'/api/normalize',{method:'POST',body:form})).status,400);assert.equal((await fetch(base+'/api/project',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);});
test('cross-origin mutation is rejected',async()=>{const r=await fetch(base+'/api/project',{method:'PUT',headers:{'Content-Type':'application/json',Origin:'https://unrelated.example'},body:'{}'});assert.equal(r.status,403);});
test('mapping job API rejects malformed input and reports missing durable jobs without exposing credentials',async()=>{
  const missing=await fetch(base+'/api/map-jobs/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status,404);
  const invalid=await fetch(base+'/api/map-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({building:{},options:{floorIds:[]}})});
  assert.equal(invalid.status,400);
  const text=await invalid.text();assert.ok(!text.includes('server-test-key'));
});
