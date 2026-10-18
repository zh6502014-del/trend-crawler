import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, run, handle, ALIASES } from '../supabase/functions/line-webhook/index.ts';
import { resolveInput, nextSession } from '../supabase/functions/line-webhook/assistant.ts';
import { explain, publicFacts, explanationKey } from '../supabase/functions/line-webhook/ai.ts';

const stock = {ticker:'2330',name:'台積電',as_of:'2026-10-16',score:75,score_7d:70,growth:80,validated:70,attention:20,flags:[],note:'PRIVATE NOTE',user_id:'PRIVATE ID'};
const ok = (data) => new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
const db = {ownerId:async()=> 'u1',get:async(path)=> path.startsWith('tw_entities')?[stock]:[],send:async()=>{}};

test('context keeps Taiwan pagination and stock actions, resets explicitly',async()=>{
  let session = nextSession({},await resolveInput('台股 3',parseCommand,db,{},ALIASES));
  const next=await resolveInput('下一頁',parseCommand,db,session,ALIASES);
  assert.deepEqual(next,{cmd:'top',tw:true,page:4});
  session=nextSession(session,next);
  session=nextSession(session,await resolveInput('台積電',parseCommand,db,session,ALIASES));
  assert.deepEqual(await resolveInput('加入自選',parseCommand,db,session,ALIASES),{cmd:'add',ticker:'2330'});
  assert.equal((await resolveInput('今日',parseCommand,db,session)).tw,true);
  assert.equal((await resolveInput('美股 今日',parseCommand,db,session)).tw,false);
  assert.deepEqual(nextSession(session,{cmd:'reset'}),{market:'us',ticker:null,page:1});
  assert.equal((await resolveInput('加入自選',parseCommand,db,{})).cmd,'message');
});

test('Chinese name operations resolve exactly and ambiguous names do not write',async()=>{
  assert.deepEqual(await resolveInput('把台積電加入自選',parseCommand,db,{},ALIASES),{cmd:'add',ticker:'2330'});
  assert.deepEqual(await resolveInput('加 輝達',parseCommand,db,{},ALIASES),{cmd:'add',ticker:'NVDA'});
  const ambiguous={...db,get:async()=>[{ticker:'2330',name:'台積電'},{ticker:'2454',name:'聯發科'}]};
  const out=await resolveInput('加 台',parseCommand,ambiguous,{},ALIASES);
  assert.equal(out.cmd,'message'); assert.equal(out.choices.length,2);
});

test('empty note reads without deleting stored contents; search is scoped',async()=>{
  const writes=[],reads=[];
  const notes={...db,get:async(p)=>{reads.push(p);return [{ticker:'2330',note:'研究筆記'}]},send:async(...args)=>writes.push(args)};
  const out=await run(parseCommand('筆記 2330'),notes,{});
  assert.match(out[0].text,/研究筆記/); assert.equal(writes.length,0);
  await run({cmd:'notes',q:'營收'},notes,{});
  assert.match(reads.at(-1),/user_id=eq.u1/); assert.match(reads.at(-1),/note=ilike/);
});

test('English name lookup establishes the real ticker for follow-up actions',async()=>{
  const named={...db,get:async(p)=>p.includes('name=ilike')?[{ticker:'AAPL',name:'Apple Inc.'}]:[]};
  const cmd=await resolveInput('Apple',parseCommand,named,{},ALIASES);
  assert.equal(cmd.ticker,'AAPL');
  assert.equal((await resolveInput('加入自選',parseCommand,named,nextSession({},cmd))).ticker,'AAPL');
  assert.equal((await resolveInput('加 Apple',parseCommand,named,{},ALIASES)).ticker,'AAPL');
});

async function signed(event) {
  const body=JSON.stringify({events:[event]});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');
  return new Request('https://example.invalid',{method:'POST',body,headers:{'x-line-signature':sig}});
}
const event = (id,type='user') => ({type:'message',webhookEventId:id,replyToken:'reply',source:{type,userId:'owner'},message:{type:'text',text:'說明'}});
function settings(){Object.assign(process.env,{LINE_CHANNEL_SECRET:'secret',LINE_CHANNEL_TOKEN:'token',LINE_USER_ID:'owner',SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'key',OWNER_UID:'u1'});}

test('owner group messages never receive private data; bad signatures are rejected',async()=>{
  settings(); let calls=0;
  const fetcher=async()=>{calls++;return ok(true)};
  assert.equal((await handle(await signed(event('group','group')),fetcher)).status,200);
  assert.equal(calls,0);
  const req=new Request('https://example.invalid',{method:'POST',body:'{}',headers:{'x-line-signature':'bad'}});
  assert.equal((await handle(req,fetcher)).status,401); assert.equal(calls,0);
});

test('persistent event claim blocks duplicates across fresh handlers; failure gives 503',async()=>{
  settings(); const seen=new Set(); let replies=0;
  const fetcher=async(url,opt={})=>{
    if(url.includes('/rpc/claim_line_event')) {const id=JSON.parse(opt.body).p_event_id;if(seen.has(id))return ok(false);seen.add(id);return ok(true);}
    if(url.includes('/line_sessions')) return ok([]);
    if(url.includes('/message/reply')) {replies++;return ok({});}
    throw new Error('Unexpected call '+url);
  };
  await handle(await signed(event('duplicate')),fetcher);
  await handle(await signed(event('duplicate')),fetcher);
  assert.equal(replies,1);
  const failure=await handle(await signed(event('storage-down')),async()=>new Response('',{status:503}));
  assert.equal(failure.status,503); assert.equal(replies,1);
});

test('rich menu postback persists market without sending a reply',async()=>{
  settings(); let state;
  const fetcher=async(url,opt={})=>{
    if(url.includes('/rpc/'))return ok(true);
    if(url.includes('/line_sessions')){if(opt.method==='POST') state=JSON.parse(opt.body);return ok([]);}
    throw new Error('Unexpected request');
  };
  await handle(await signed({type:'postback',webhookEventId:'menu-tw',source:{type:'user',userId:'owner'},postback:{data:'menu=tw'}}),fetcher);
  assert.equal(state.market,'tw'); assert.equal(state.ticker,null);
});

test('AI default is disabled and private fields never enter public facts',async()=>{
  delete process.env.LINE_AI_ENABLED;
  let rpc=0;
  const out=await explain({cmd:'explain',ticker:'2330'},{get:async()=>[stock],rpc:async()=>{rpc++}},{});
  assert.match(out[0].text,/7 日變化 \+5.0/); assert.equal(rpc,0);
  assert.ok(!JSON.stringify(publicFacts(stock)).includes('PRIVATE'));
});

test('AI jobs consume a claim once, cache results, and poll without another API call',async()=>{
  Object.assign(process.env,{LINE_AI_ENABLED:'1',GEMINI_API_KEY:'fake',LINE_AI_DAILY_LIMIT:'10'});
  let cached,apiCalls=0,claims=0;const jobs=[];
  const mock={get:async(p)=>p.startsWith('tw_latest_board')?[stock]:cached?[cached]:[],
    rpc:async()=>{claims++;cached={status:'pending',updated_at:new Date().toISOString()};return 'claimed'},
    send:async(m,p,b)=>{cached={...cached,...b}}};
  const ctx={waitUntil:(p)=>jobs.push(p),fetchFn:async(url,opt)=>{apiCalls++;assert.ok(!opt.body.includes('PRIVATE'));return ok({candidates:[{content:{parts:[{text:'已依公開資料整理。'}]}}]})}};
  const out=await explain({cmd:'explain',ticker:'2330'},mock,ctx);
  assert.match(out[0].text,/正在整理/);await Promise.all(jobs);
  const again=await explain({cmd:'explanation',ticker:'2330'},mock,ctx);
  assert.match(again[0].text,/AI 解讀/);assert.equal(apiCalls,1);assert.equal(claims,1);
  assert.notEqual(await explanationKey(publicFacts(stock),'a'),await explanationKey(publicFacts({...stock,score:76}),'a'));
  delete process.env.LINE_AI_ENABLED;
});

test('AI budget exhaustion and API errors preserve factual queries',async()=>{
  Object.assign(process.env,{LINE_AI_ENABLED:'1',GEMINI_API_KEY:'fake'});
  let api=0;const jobs=[];let result;
  const mock={get:async(p)=>p.startsWith('tw_latest_board')?[stock]:[],rpc:async()=> 'limited',send:async(m,p,b)=>{result=b}};
  const ctx={waitUntil:(p)=>jobs.push(p),fetchFn:async()=>{api++;return new Response('',{status:429})}};
  const limited=await explain({cmd:'explain',ticker:'2330'},mock,ctx);
  assert.match(limited[0].text,/額度已用完/);assert.equal(api,0);
  mock.rpc=async()=> 'claimed';
  await explain({cmd:'explain',ticker:'2330'},mock,ctx);await Promise.all(jobs);
  assert.equal(result.status,'failed');assert.equal(api,1);
  delete process.env.LINE_AI_ENABLED;
});
