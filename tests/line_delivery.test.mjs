import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {handle} from '../supabase/functions/line-webhook/index.ts';
import {durableReply,reply} from '../supabase/functions/line-webhook/delivery.ts';
const ok=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const uuid='00000000-0000-0000-0000-000000000001';
async function database(){
  const sql=new PGlite();
  await sql.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  const schema=fs.readFileSync(new URL('../supabase/schema_line.sql',import.meta.url),'utf8');
  await sql.exec(schema);await sql.exec(schema);
  return sql;
}
async function request(id,text='提醒 2330 分數>80'){
  Object.assign(process.env,{LINE_CHANNEL_SECRET:'secret',LINE_CHANNEL_TOKEN:'token',LINE_USER_ID:'owner',OWNER_UID:uuid,SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'key'});
  const body=JSON.stringify({events:[{type:'message',webhookEventId:id,replyToken:'same-token',timestamp:Date.now(),source:{type:'user',userId:'owner'},message:{type:'text',text}}]});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');
  return new Request('https://example.invalid',{method:'POST',body,headers:{'x-line-signature':signature}});
}
function provider(sql,statuses){
  const state={writes:0,replies:[],failFinish:false};
  state.fetch=async(url,opt={})=>{
    const body=opt.body?JSON.parse(opt.body):null;
    const fn=url.split('/rpc/')[1];
    if(fn){
      if(fn==='finish_line_reply' && state.failFinish){state.failFinish=false;return new Response('',{status:503});}
      const placeholders=Object.keys(body).map((key,i)=>`${key} => $${i+1}`).join(',');
      const values=Object.values(body).map(x=>typeof x==='object' && x!==null?JSON.stringify(x):x);
      return ok((await sql.query(`select ${fn}(${placeholders}) as result`,values)).rows[0].result);
    }
    if(url.includes('/message/reply')){state.replies.push(body.messages);const status=statuses.shift() || 200;if(status==='network')throw Error('private URL must not be logged');return new Response('{}',{status});}
    if(url.includes('/tw_entities?'))return ok([{ticker:'2330'}]);
    if(url.endsWith('/user_alerts') && opt.method==='POST'){state.writes++;return ok(null);}
    if(url.includes('/user_alerts') || url.includes('/line_sessions') || url.includes('/line_preferences'))return ok([]);
    throw Error('unexpected fetch');
  };
  return state;
}
test('reply 500 then success replays frozen outcome without repeating an alert write',async()=>{
  const sql=await database();try{
    const state=provider(sql,[500,200]);
    assert.equal((await handle(await request('recover'),state.fetch)).status,503);
    assert.equal((await handle(await request('recover'),state.fetch)).status,200);
    assert.equal(state.writes,1);assert.deepEqual(state.replies[0],state.replies[1]);
    assert.equal((await handle(await request('recover'),state.fetch)).status,200);assert.equal(state.replies.length,2);
    const row=(await sql.query("select * from line_events where event_id='recover'")).rows[0];
    assert.equal(row.status,'replied');assert.equal(row.reply_messages,null);
  }finally{await sql.close();}
});
test('network uncertainty and lost receipt never repeat the operation; permanent rejection is recorded',async()=>{
  const sql=await database();try{
    const state=provider(sql,['network',400]);
    assert.equal((await handle(await request('network'),state.fetch)).status,503);
    assert.equal((await handle(await request('network'),state.fetch)).status,200);
    assert.equal(state.writes,1);
    assert.equal((await sql.query("select error_code from line_events where event_id='network'")).rows[0].error_code,'reply_http_400');
    const lost=provider(sql,[200,400]);lost.failFinish=true;
    assert.equal((await handle(await request('receipt'),lost.fetch)).status,503);
    await sql.exec("update line_events set updated_at=now()-interval '1 minute' where event_id='receipt'");
    await handle(await request('receipt'),lost.fetch);assert.equal(lost.writes,1);
  }finally{await sql.close();}
});
test('SQL claims serialize concurrent owners, fence stale workers and never reexecute uncertain writes',async()=>{
  const sql=await database();try{
    const a=crypto.randomUUID(),b=crypto.randomUUID();
    const begin=async(id,attempt)=>(await sql.query('select begin_line_event($1,$2) as v',[id,attempt])).rows[0].v;
    const results=await Promise.all([begin('race',a),begin('race',b)]);
    assert.deepEqual(results.map(x=>x.action).sort(),['busy','execute']);
    await sql.exec("update line_events set updated_at=now()-interval '1 minute' where event_id='race'");
    const replay=await begin('race',b);assert.equal(replay.action,'reply');assert.match(replay.messages[0].text,/無法確認/);
    assert.equal((await sql.query("select prepare_line_reply('race',$1,'[]',null) as v",[a])).rows[0].v,false);
    await sql.exec(fs.readFileSync(new URL('./line_schema.sql',import.meta.url),'utf8'));
    assert.equal((await sql.query("select has_table_privilege('anon','line_preferences','select') as v")).rows[0].v,false);
    assert.equal((await sql.query("select has_function_privilege('authenticated','begin_line_event(text,uuid)','execute') as v")).rows[0].v,false);
  }finally{await sql.close();}
});
test('retry budget and payload lifetime are bounded; legacy events stay terminal',async()=>{
  const sql=await database();try{
    await sql.exec("insert into line_events(event_id) values ('old');");
    const call=async(id)=>(await sql.query('select begin_line_event($1,$2) as v',[id,crypto.randomUUID()])).rows[0].v;
    assert.equal((await call('old')).action,'done');
    await call('expired');
    await sql.exec("update line_events set created_at=now()-interval '21 minutes',status='retry',reply_messages='[{\"type\":\"text\",\"text\":\"private\"}]' where event_id='expired'");
    assert.equal((await call('expired')).action,'done');
    assert.equal((await sql.query("select reply_messages from line_events where event_id='expired'")).rows[0].reply_messages,null);
    await call('limit');await sql.exec("update line_events set status='retry',attempts=3 where event_id='limit'");
    assert.equal((await call('limit')).action,'done');
  }finally{await sql.close();}
});
test('lost preparation acknowledgement recovers without rerunning a completed write',async()=>{
  const sql=await database();try{
    const state=provider(sql,[200]);let lose=true;
    const fetcher=async(url,opt)=>{
      const result=await state.fetch(url,opt);
      if(url.includes('/rpc/prepare_line_reply') && lose){lose=false;throw Error('response lost');}
      return result;
    };
    assert.equal((await handle(await request('prepare'),fetcher)).status,503);
    assert.equal(state.replies.length,0);
    await sql.exec("update line_events set updated_at=now()-interval '1 minute' where event_id='prepare'");
    assert.equal((await handle(await request('prepare'),fetcher)).status,200);
    assert.equal(state.writes,1);assert.match(state.replies[0][0].text,/已設定/);
  }finally{await sql.close();}
});
test('dashboard capabilities never enter retry storage; transient reply errors are explicit',async()=>{
  const safe=durableReply({cmd:'dash'},[{type:'text',text:'https://example/#line_token=SECRET'}]);
  assert.ok(!JSON.stringify(safe).includes('SECRET'));
  assert.equal((await reply(async()=>new Response('',{status:429}),'t','r',[])).status,'retry');
  assert.equal((await reply(async()=>new Response('',{status:401}),'t','r',[])).status,'failed');
});
