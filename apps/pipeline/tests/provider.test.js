import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {OpenAIProvider} from '../server/provider.js';

const fixture=JSON.parse(await readFile(new URL('../public/sample/original-extraction.json',import.meta.url),'utf8'));
const geometry={floorName:fixture.floorName,spaces:fixture.spaces,walls:fixture.walls,doors:fixture.doors,pois:fixture.pois,issues:[{id:'source-review',message:'Uncertain doorway',resolved:true,resolution:'Model-approved'}]};
const completed=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('OpenAI sends the image with the exact model, strict schema, and server-only credentials; review is mandatory',async()=>{
 let captured;
 const provider=new OpenAIProvider({apiKey:'test-server-key',model:'gpt-6.1-sol',fetchImpl:async(url,options)=>{captured={url,...options};return response(completed(geometry));}});
 const map=await provider.extract(fixture.source);
 const body=JSON.parse(captured.body);
 assert.equal(captured.url,'https://api.openai.com/v1/responses');
 assert.equal(captured.headers.Authorization,'Bearer test-server-key');
 assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.store,false);
 assert.equal(body.text.format.strict,true);assert.equal(body.text.format.schema.additionalProperties,false);
 assert.equal(body.input[0].content[1].image_url,fixture.source.dataUrl);
 assert.equal(map.extraction.provider,'OpenAI');assert.equal(map.extraction.model,'gpt-6.1-sol');
 assert.deepEqual(map.source,fixture.source);assert.deepEqual(map.graph,{nodes:[],edges:[]});assert.equal(map.scale,null);
 assert.equal(map.review.status,'draft');assert.equal(map.review.issues.length,2);
 assert.ok(map.review.issues.every(i=>!i.resolved&&i.resolution===''));
 assert.equal(new Set(map.review.issues.map(i=>i.id)).size,2);
 assert.ok(!JSON.stringify(map).includes('test-server-key'));
});

for(const [name,payload,status,expected] of [
 ['HTTP error',{error:{message:'private provider details'}},401,/HTTP 401/],
 ['incomplete response',{...completed(geometry),status:'incomplete'},200,/did not complete/],
 ['refusal',{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'Declined'}]}]},200,/declined/],
 ['invalid JSON',{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{'}]}]},200,/invalid extraction/],
 ['invalid schema',completed({...geometry,spaces:[{id:'bad'}]}),200,/invalid extraction/]
])test(`OpenAI rejects ${name} without a fallback call`,async()=>{
 let calls=0;
 const provider=new OpenAIProvider({apiKey:'test-key',fetchImpl:async()=>{calls++;return response(payload,status);}});
 await assert.rejects(()=>provider.extract(fixture.source),expected);assert.equal(calls,1);
});

test('missing OpenAI key never attempts a network request',async()=>{
 const provider=new OpenAIProvider({apiKey:'',fetchImpl:()=>{assert.fail('Unexpected request');}});
 await assert.rejects(()=>provider.extract(fixture.source),/OPENAI_API_KEY/);
});
