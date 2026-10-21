import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {assess,research} from '../supabase/functions/line-webhook/research.ts';
const sandbox={};vm.runInNewContext(fs.readFileSync(new URL('../docs/research.js',import.meta.url),'utf8'),sandbox);
const base={ticker:'2330',name:'台積電',as_of:'2026-10-21',rev_yoy:.3,rev_3m_yoy:.3,rev_accel:.1,rs_6m:-.1,revenue_history_status:'complete',revenue_months:6,revenue_as_of:'2026-09-01',revenue_streak_months:4,rev_streak:3,fundamentals_fetched_at:'2026-10-21',growth:80,rel_val:75,flags:[]};
test('LINE research matches website assessment including missing, risky and stale facts',()=>{
  for(const market of ['us','tw']) for(const row of [base,{}, {...base,flags:['high_debt']},{...base,as_of:'2020-01-01'},{...base,revenue_history_status:'partial'},{...base,scoring_version:'legacy-unverified'},{...base,rev_yoy:null},{...base,rev_accel:null},{...base,rs_6m:.4},{...base,fundamentals_fetched_at:null}]){
    assert.equal(JSON.stringify(assess(row,market,'2026-10-21')),JSON.stringify(sandbox.Research.assess(row,market,'2026-10-21')));
  }
});
test('radar excludes risky or incomplete candidates from priority and offers real command choices',async()=>{
  const rows=[base,{...base,ticker:'1111',flags:['high_debt']},{...base,ticker:'2222',revenue_months:2}];
  const out=await research({cmd:'radar',tw:true},{get:async()=>rows},{today:'2026-10-21'});
  assert.match(out[0].text,/2330/);assert.doesNotMatch(out[0].text,/1111|2222/);
  assert.ok(out[0].quickReply.items.some(x=>x.action.text==='研究 2330'));
});
test('valuation excludes missing metrics, respects market and labels relative scores',async()=>{
  let reads=0;const db={get:async()=>{reads++;return [base,{...base,ticker:'1111',rel_val:null},{...base,ticker:'2222',growth:20}]}};
  const us=await research({cmd:'value',tw:false},db);assert.equal(reads,0);assert.match(us[0].text,/目前提供台股/);
  const out=await research({cmd:'value',tw:true},db,{today:'2026-10-21'});
  assert.match(out[0].text,/2330/);assert.doesNotMatch(out[0].text,/1111|2222/);assert.match(out[0].text,/不是絕對低估/);
});
test('private research cards are scoped to owner and market and never invoke AI',async()=>{
  const paths=[];const db={ownerId:async()=>'owner',get:async(p)=>{paths.push(p);return [{ticker:'2330',status:'watching',thesis:'私人論點',review_on:'2026-10-01'}]}};
  const out=await research({cmd:'researchcards',tw:true},db,{today:'2026-10-21',fetchFn:()=>{throw Error('must not call AI')}});
  assert.match(paths[0],/user_id=eq.owner&market=eq.tw/);assert.match(out[0].text,/已到驗證日期/);
  assert.equal(out[0].quickReply.items[0].action.text,'儀表板 2330');
});
