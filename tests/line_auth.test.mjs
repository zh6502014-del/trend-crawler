import test from 'node:test';
import assert from 'node:assert/strict';
import login from '../docs/line-auth.js';
import { dashboardLoginUrl } from '../supabase/functions/line-webhook/index.ts';
const token='a'.repeat(64);

test('owner login uses the configured dashboard and preserves the stock without redirect tokens',()=>{
  for(const data of [{hashed_token:token},{properties:{hashed_token:token}}]) {
    const result=new URL(dashboardLoginUrl('https://site.invalid/research/?t=2330',data));
    assert.equal(result.origin,'https://site.invalid');
    assert.equal(result.search,'?t=2330');
    assert.equal(new URLSearchParams(result.hash.slice(1)).get('line_token'),token);
    assert.ok(!result.search.includes(token));
  }
  assert.equal(dashboardLoginUrl('https://site.invalid',{}),null);
  assert.equal(dashboardLoginUrl('https://site.invalid',{hashed_token:'bad token'}),null);
  assert.equal(dashboardLoginUrl('http://site.invalid',{hashed_token:token}),null);
});

test('browser removes the login token before sign-in while preserving ticker navigation',()=>{
  let clean;
  const entry=login.read({href:'https://site.invalid/research/?t=2330#line_token='+token+'&type=email'},
    {state:null,replaceState:(_s,_t,url)=>{clean=url;}});
  assert.deepEqual(entry,{token}); assert.equal(clean,'/research/?t=2330');
  const unchanged=login.read({href:'https://site.invalid/#t=NVDA'}, {replaceState:()=>assert.fail('ordinary navigation must stay intact')});
  assert.equal(unchanged,null);
});

test('valid one-time token establishes a session without an email round trip',async()=>{
  const calls=[];
  const auth={verifyOtp:async(input)=>{calls.push(input);return {data:{session:{user:{id:'owner'}}}};},getSession:()=>assert.fail('not needed')};
  assert.deepEqual(await login.signIn(auth,{token}),{ok:true});
  assert.deepEqual(calls,[{token_hash:token,type:'email'}]);
});

test('old or consumed links reuse a current session or request a fresh LINE link',async()=>{
  let cleaned;
  const entry=login.read({href:'https://site.invalid/?t=2330#error=access_denied&error_code=otp_expired&error_description=expired'},
    {replaceState:(_s,_t,u)=>{cleaned=u;}});
  assert.equal(entry.expired,true); assert.equal(cleaned,'/?t=2330');
  const auth={verifyOtp:async()=>({error:{message:'Token expired'}}), getSession:async()=>({data:{session:{user:{id:'owner'}}}})};
  assert.deepEqual(await login.signIn(auth,{token}),{ok:true});
  auth.getSession=async()=>({data:{session:null}});
  assert.deepEqual(await login.signIn(auth,{token}),{ok:false,reason:'expired'});
  assert.deepEqual(await login.signIn(auth,entry),{ok:false,reason:'expired'});
  auth.verifyOtp=async()=>{throw new Error('Network unavailable')};
  assert.deepEqual(await login.signIn(auth,{token}),{ok:false,reason:'unavailable'});
});
