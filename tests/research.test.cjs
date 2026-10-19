const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({Intl,Date});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../docs/research.js'),'utf8'),context);
const assess = (d, market='us') => JSON.parse(JSON.stringify(context.Research.assess(d,market,'2026-10-18')));
const base = {ticker:'ABC',as_of:'2026-10-16',fundamentals_fetched_at:'2026-10-16T00:00:00Z',rev_yoy:.3,rev_streak:3,rs_6m:-.1,flags:[]};

test('radar prioritises business/price divergence independently of total score or attention',()=>{
  assert.equal(assess({...base,score:1,attention:100}).bucket,'priority');
  assert.deepEqual(assess({...base,score:1,attention:100}),assess({...base,score:99,attention:0}));
  assert.equal(assess({...base,rs_6m:.2}).bucket,'observe');
});
test('risk and missing data cannot be hidden by strong clues',()=>{
  assert.equal(assess({...base,flags:['short_runway']}).bucket,'risk');
  assert.equal(assess({...base,runway_months:6}).bucket,'risk');
  assert.equal(assess({...base,flags:['stale_fundamentals']}).bucket,'incomplete');
  assert.equal(assess({...base,as_of:'2026-10-01'}).bucket,'incomplete');
  assert.equal(assess({...base,as_of:'2026-10-19'}).bucket,'incomplete');
  assert.equal(assess({...base,rev_yoy:null,rs_6m:null}).clues.length,0);
});
test('Taiwan radar requires actual history and cannot reuse old synthetic streak',()=>{
  assert.equal(assess(base,'tw').bucket,'incomplete');
  const row={...base,revenue_history_status:'complete',revenue_months:6,revenue_streak_months:4,revenue_as_of:'2026-09-01',rev_3m_yoy:.2,rev_accel:.08};
  assert.equal(assess(row,'tw').bucket,'priority');
  assert.equal(assess(row,'tw').clues.length,3);
  assert.equal(assess({...row,revenue_months:2},'tw').bucket,'incomplete');
  assert.equal(assess({...row,rev_accel:null,revenue_streak_months:null},'tw').clues.length,1);
});
