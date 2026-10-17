import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateTokens,validate} from './fullchain-pilot.mjs';

test('GPT pricing counts cache writes separately and does not double-count reasoning output',()=>{
 const u={input_tokens:2460,input_tokens_details:{cache_write_tokens:2457,cached_tokens:0},output_tokens:1383,output_tokens_details:{reasoning_tokens:488}};
 assert.ok(Math.abs(estimateTokens('openai',u)-.0199785)<1e-10);
});
test('Gemini estimate includes separately reported thoughts and uses undiscounted global rates',()=>{
 assert.equal(estimateTokens('vertex',{promptTokenCount:1000,candidatesTokenCount:500,thoughtsTokenCount:500,cachedContentTokenCount:200}),.02324);
});
test('missing usage is unknown and malformed cache accounting is rejected',()=>{
 assert.equal(estimateTokens('openai',null),null);
 assert.equal(estimateTokens('vertex',{}),null);
 assert.equal(estimateTokens('openai',{input_tokens:5,output_tokens:5,input_tokens_details:{cache_write_tokens:6}}),null);
});
test('local schema validation decodes Unicode as UTF-8 on Windows without extending limits',()=>{
 const schema={type:'string',maxLength:180},value='A'.repeat(179)+'–';
 assert.doesNotThrow(()=>validate(schema,value));
 assert.throws(()=>validate(schema,value+'A'),/maxLength/);
 assert.doesNotThrow(()=>validate({type:'string',maxLength:2},'楼梯'));
});
