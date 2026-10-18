function fixture(options) {
  window.__calls = []; window.__otp = 0; window.__writes = []; window.__errors = [...(options.errors || [])]; window.__signedIn = !options.login;
  const stamp = '2026-10-16T22:00:00Z';
  const tickers = ['FINB','ROBT','MDTX','CLOUD','SOLR','NOVA','AERO','BIOX','ECHO','LUMA','WAVE','GRID'];
  const names = ['Example Regional Bank','Robotics Dynamics','Medical Technology Group','Cloud Systems','Solar Materials','Nova Networks','Aero Components','Bio Discovery','Echo Technologies','Luma Holdings','Wave Energy','Grid Infrastructure'];
  const rows = tickers.map((ticker,i)=>({ticker,name:names[i],as_of:options.oldUs?'2026-10-09':'2026-10-16',batch_id:'batch-ux',published_at:stamp,scoring_version:'2',board:i<9?'main':'watch',rank:i<9?i+1:i-8,score:76.4-i*3.1,score_7d:i===2?null:72-i*3,rank_7d:i===2?null:i+2,growth:87-i*3,validated:82-i*2,accessibility:74+i,attention:18+i*4,price:23.54+i,mkt_cap:420e6+i*70e6,dollar_vol:1.2e6+i*1e5,rev_yoy:.42-i*.02,rev_streak:4,ret_1m:.12,ret_3m:.24,ret_6m:.38,rs_6m:.15,dist_high:-.08,gross_margin:i===0?null:.43,profit_margin:i===0?.25:.12,sector:i===0?'金融與保險':'科技',industry:i===0?'Regional Banking':'Industrial Technology',flags:i===2?['short_runway','stale_fundamentals']:[],hn_mentions:0,fundamentals_fetched_at:stamp,fundamentals_age_days:2,price_source:'massive'}));
  window.__data = {
    latest_board:rows,
    tw_latest_board:[{...rows[1],ticker:'2330',name:'台積電（模擬）',as_of:'2026-10-16',board:'tw_main',rank:1,exchange:'TWSE',price:1000,mkt_cap:26e12,rev_cum_yoy:.3,inst_20d:.12,flags:['inst_buy']},{...rows[2],ticker:'2317',name:'鴻海（模擬）',as_of:'2026-10-16',board:'tw_main',rank:2,exchange:'TWSE',price:210,flags:[]}],
    latest_fundraises:[{accession:'raise-1',cik:'123',issuer:'New Robotics Labs',portal:'Example Portal',filed_at:'2026-10-15',deadline:'2099-11-20',target_amount:500000,max_amount:2000000,revenue:750000,revenue_prior:500000,net_income:-150000,cash:600000,employees:10}],
    crawl_runs:[{status:'ok',started_at:stamp,finished_at:stamp,stats:{public:{status:'ok',fundamentals:{expired:0},attention:{failed:0}},formc:{status:'ok'}}}],
    smart_money:[{ticker:'ROBT',score:30,tags:['insider_cluster'],buyers_30d:3,buy_value_30d:550000}],
    user_watch:[{ticker:'ROBT',note:'模擬筆記'}],
    scores:Array.from({length:20},(_,i)=>({as_of:`2026-09-${String(i+1).padStart(2,'0')}`,score:50+i})),
    price_series:[{ticker:'FINB',series:Array.from({length:20},(_,i)=>[`2026-09-${String(i+1).padStart(2,'0')}`,15+i/2])}],
    report_card:[{as_of:'2026-10-01',horizon:5,n:20,avg_ret:.04,spy_ret:.01,excess:.03,hit_rate:.65,best:'ROBT',best_ret:.15,worst:'BIOX',worst_ret:-.05}],
    tw_report_card:[{as_of:'2026-10-02',horizon:5,n:20,avg_ret:.03,spy_ret:.01,excess:.02,hit_rate:.7,best:'2330',best_ret:.12,worst:'2317',worst_ret:-.03}]
  };
  window.__data.user_watch = JSON.parse(localStorage.getItem('usability.watch') || 'null') || window.__data.user_watch;
  class Query {
    constructor(table) {this.table=table;this.a=0;this.b=Infinity;this.filters=[];this.orders=[];}
    select(cols){this.cols=cols;return this;} order(key,opts={}){this.orders.push([key,opts.ascending!==false]);return this;}
    eq(k,v){this.filters.push(r=>r[k]===v);return this;} gt(k,v){this.filters.push(r=>r[k]>v);return this;}
    gte(k,v){this.filters.push(r=>r[k]>=v);return this;} range(a,b){this.a=a;this.b=b+1;return this;}
    limit(n){this.b=n;return this;} maybeSingle(){this.single=true;return this;}
    upsert(payload){this.payload=payload;this.operation="upsert";return this;} delete(){this.operation="delete";return this;}
    then(resolve,reject){
      window.__calls.push(this.table);
      return new Promise(r=>setTimeout(r,options.slowReports && this.table==='report_card'?900:0)).then(()=>{
        if(window.__errors.includes(this.table))return {data:null,error:{message:'模擬來源暫時無法載入'}};
        if (this.operation) {
          const records = window.__data[this.table] || [];
          if (this.operation === 'upsert') {
            const index = records.findIndex(r => r.ticker === this.payload.ticker);
            if(index < 0) records.push({...this.payload}); else records[index] = {...records[index],...this.payload};
            window.__data[this.table] = records;
          } else window.__data[this.table] = records.filter(r=>!this.filters.every(f=>f(r)));
          if(this.table==='user_watch')localStorage.setItem('usability.watch',JSON.stringify(window.__data[this.table]));
          window.__writes.push({table:this.table,operation:this.operation,payload:this.payload});
          return {data:null,error:null};
        }
        let data=[...(window.__data[this.table]||[])].filter(r=>this.filters.every(f=>f(r)));
        for(const [k,asc] of [...this.orders].reverse())data.sort((a,b)=>((a[k]>b[k])-(a[k]<b[k]))*(asc?1:-1));
        data=data.slice(this.a,this.b);return {data:this.single?data[0]||null:data,error:null};
      }).then(resolve,reject);
    }
  }
  window.supabase={createClient:()=>({from:t=>new Query(t),auth:{
    onAuthStateChange:cb=>{window.__auth=cb;},getSession:async()=>({data:{session:window.__signedIn?{}:null}}),
    signInWithOtp:async args=>{window.__otp++; window.__otpArgs=args;await new Promise(r=>setTimeout(r,options.slowLogin?700:100));if(window.__loginFail ?? options.loginFail)throw new Error('Network unavailable');return {error:null};},
    signOut:async()=>({error:null})
  }})};
}

module.exports = fixture;
