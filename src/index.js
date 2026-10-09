const SCHEMA=[
'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS holdings (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL,name TEXT,shares REAL NOT NULL DEFAULT 0,avg_cost REAL NOT NULL DEFAULT 0,note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT,holding_id INTEGER,code TEXT NOT NULL,side TEXT NOT NULL,price REAL NOT NULL,shares REAL NOT NULL,fee REAL NOT NULL DEFAULT 0,traded_at TEXT NOT NULL,note TEXT)',
'CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,level TEXT NOT NULL,title TEXT NOT NULL,detail TEXT,source TEXT,created_at TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0)',
'CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,report_type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS data_health (source TEXT PRIMARY KEY,status TEXT NOT NULL,latency_ms INTEGER,checked_at TEXT NOT NULL,detail TEXT)',
'CREATE INDEX IF NOT EXISTS idx_trades_code_time ON trades(code,traded_at)',
'CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC)'
];
const now=()=>new Date().toISOString(), json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store'}});
const secid=c=>/^(6|688|900)/.test(String(c))?'1.'+c:'0.'+c;
async function init(db){if(db)for(const s of SCHEMA)await db.prepare(s).run()}
async function quote(code){code=String(code||'').trim();if(!/^\d{6}$/.test(code))throw Error('股票代码应为6位数字');const fields='f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168';const headers={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'};const urls=['https://push2.eastmoney.com/api/qt/stock/get','https://push2delay.eastmoney.com/api/qt/stock/get'];const t=Date.now();let lastErr='';for(const host of urls){try{const u=new URL(host);u.searchParams.set('secid',secid(code));u.searchParams.set('fields',fields);u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');u.searchParams.set('_',String(Date.now()));const r=await fetch(u,{headers,signal:AbortSignal.timeout(3000),cf:{cacheTtl:0,cacheEverything:false}});if(!r.ok){lastErr=host+' HTTP '+r.status;continue}const body=await r.json();const d=body?.data;if(!d){lastErr=host+' empty data';continue}const n=(v,div=1)=>(v==null||v==='-')?null:Number(v)/div;return{source:host.includes('delay')?'eastmoney-delay':'eastmoney',fetchedAt:now(),latencyMs:Date.now()-t,code:d.f57||code,name:d.f58||'',price:n(d.f43,100),open:n(d.f46,100),high:n(d.f44,100),low:n(d.f45,100),prevClose:n(d.f60,100),volume:n(d.f47),amount:n(d.f48),turnoverRate:n(d.f168,100),pe:n(d.f162,100),pb:n(d.f167,100),totalMarketCap:n(d.f116),circulatingMarketCap:n(d.f117)}}catch(e){lastErr=host+' '+e.message}}const sym=/^(6|688|5|9)/.test(code)?'sh'+code:'sz'+code;try{const u=new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');u.searchParams.set('param',sym+',day,,,1,qfq');u.searchParams.set('_',String(Date.now()));const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(3000)});if(r.ok){const d=await r.json();const a=d?.data?.[sym]?.qt?.[sym]||d?.data?.[sym]?.qt; if(Array.isArray(a)&&a.length>46){const n=(v)=>(v==null||v==='-'||v==='')?null:Number(v);return{source:'tencent-fallback',fetchedAt:now(),latencyMs:Date.now()-t,code:a[2]||code,name:a[1]||'',price:n(a[3]),open:n(a[5]),high:n(a[33]),low:n(a[34]),prevClose:n(a[4]),volume:n(a[36]),amount:n(a[37])*10000,turnoverRate:n(a[38]),pe:n(a[39]),pb:n(a[46]),totalMarketCap:n(a[45])*100000000,circulatingMarketCap:n(a[44])*100000000}}}}catch(e){lastErr+='; Tencent '+e.message}throw Error(lastErr||'Market data providers unavailable')}
async function kline(code,limit=120){
 code=String(code||'').trim();
 if(!/^\\d{6}$/.test(code)) throw Error('股票代码应为6位数字');
 const count=Math.min(500,Math.max(20,Number.isFinite(+limit)?+limit:120));
 const headers={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'};
 const safeNum=v=>{if(v===undefined||v===null||v===''||v==='-')return null;const n=Number(v);return Number.isFinite(n)?n:null};
 const withDerivedChanges=rows=>rows.map((row,i)=>({...row,changePct:row.changePct??(i>0&&rows[i-1].close?Number(((row.close/rows[i-1].close-1)*100).toFixed(4)):null)}));
 const quality=rows=>{const n=rows.length||1;return{rowCount:rows.length,amountCoveragePct:Math.round(rows.filter(x=>x.amount!=null).length/n*100),changePctCoveragePct:Math.round(rows.filter(x=>x.changePct!=null).length/n*100),turnoverCoveragePct:Math.round(rows.filter(x=>x.turnover!=null).length/n*100)}};
 const started=Date.now();
 let eastmoneyError='';
 try{
  const u=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  u.searchParams.set('secid',secid(code));
  u.searchParams.set('fields1','f1,f2,f3,f4,f5,f6');
  u.searchParams.set('fields2','f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  u.searchParams.set('klt','101');
  // Use unadjusted daily prices so historical OHLC and moving averages use a consistent price basis.
  u.searchParams.set('fqt','0');
  u.searchParams.set('end','20500101');
  u.searchParams.set('lmt',String(count));
  u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');
  u.searchParams.set('_',String(Date.now()));
  const r=await fetch(u,{headers,signal:AbortSignal.timeout(3500),cf:{cacheTtl:0,cacheEverything:false}});
  if(!r.ok) throw Error('Eastmoney HTTP '+r.status);
  const body=await r.json();
  const klines=body?.data?.klines||[];
  const rows=withDerivedChanges(klines.map(item=>{
   const p=String(item).split(',');
   return{date:p[0],open:safeNum(p[1]),close:safeNum(p[2]),high:safeNum(p[3]),low:safeNum(p[4]),volume:safeNum(p[5]),amount:safeNum(p[6]),changePct:safeNum(p[8]),turnover:safeNum(p[10])};
  }).filter(x=>x.date&&x.close!=null));
  if(!rows.length) throw Error('Eastmoney returned no valid K-line rows');
  return{source:'eastmoney',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:'none'};
 }catch(e){eastmoneyError=String(e?.message||e)}
 // Tencent fallback: retain fields actually supplied by its K-line payload; derive daily return from adjacent closes when missing.
 try{
  const sym=/^(6|688|5|9)/.test(code)?'sh'+code:'sz'+code;
  const u=new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
  u.searchParams.set('param',sym+',day,,,'+count+',');
  u.searchParams.set('_',String(Date.now()));
  const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(3500)});
  if(!r.ok) throw Error('Tencent HTTP '+r.status);
  const body=await r.json();
  const node=body?.data?.[sym];
  const arr=node?.day||node?.qfqday||node?.hfqday||[];
  const raw=arr.map(p=>({date:p[0],open:safeNum(p[1]),close:safeNum(p[2]),high:safeNum(p[3]),low:safeNum(p[4]),volume:safeNum(p[5]),amount:safeNum(p[6]),changePct:null,turnover:safeNum(p[7])})).filter(x=>x.date&&x.close!=null);
  const rows=withDerivedChanges(raw);
  if(!rows.length) throw Error('Tencent returned no valid K-line rows');
  return{source:'tencent-fallback',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:node?.day?'none':'unknown',warning:'东方财富K线不可用，已切换腾讯备用源；腾讯未提供的字段保持为空。',primaryError:eastmoneyError};
 }catch(e){throw Error('K线数据源均不可用。东方财富：'+eastmoneyError+'；腾讯：'+String(e?.message||e))}
}
async function health(db,status,detail,latency){if(db)await db.prepare('INSERT INTO data_health(source,status,latency_ms,checked_at,detail) VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET status=excluded.status,latency_ms=excluded.latency_ms,checked_at=excluded.checked_at,detail=excluded.detail').bind('eastmoney',status,latency||null,now(),detail||'').run()}
async function listHoldings(db){if(!db)return[];const r=await db.prepare('SELECT * FROM holdings ORDER BY updated_at DESC').run();const out=[];for(const h of r.results||[]){let q=null;try{q=await quote(h.code)}catch{}const pnl=q?.price?(q.price-h.avg_cost)*h.shares:null;out.push({...h,quote:q,pnl,pnlPct:q?.price&&h.avg_cost?(q.price/h.avg_cost-1)*100:null,marketValue:q?.price?q.price*h.shares:null})}return out}
async function addTrade(db,b){const code=String(b.code||'').trim(),side=b.side==='SELL'?'SELL':'BUY',price=Number(b.price),shares=Number(b.shares),fee=Number(b.fee||0),t=now();if(!code||!price||!shares)throw Error('交易参数不完整');let h=await db.prepare('SELECT * FROM holdings WHERE code=? ORDER BY id LIMIT 1').bind(code).first();if(!h){await db.prepare('INSERT INTO holdings(code,name,shares,avg_cost,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(code,b.name||'',side==='BUY'?shares:-shares,side==='BUY'?price:0,b.note||'',t,t).run();h=await db.prepare('SELECT * FROM holdings WHERE code=? ORDER BY id DESC LIMIT 1').bind(code).first()}else{const os=+h.shares,oc=+h.avg_cost,ns=side==='BUY'?os+shares:os-shares,nc=side==='BUY'&&ns>0?((os*oc)+(shares*price)+fee)/ns:ns>0?oc:0;await db.prepare('UPDATE holdings SET shares=?,avg_cost=?,updated_at=? WHERE id=?').bind(ns,nc,t,h.id).run()}await db.prepare('INSERT INTO trades(holding_id,code,side,price,shares,fee,traded_at,note) VALUES(?,?,?,?,?,?,?,?)').bind(h.id,code,side,price,shares,fee,b.tradedAt||t,b.note||'').run();return{ok:true}}
async function analyze(code){const q=await quote(code),k=await kline(code),r=k.rows,last=r.at(-1),avg=n=>{const a=r.slice(-n).map(x=>x.close).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null},ma5=avg(5),ma20=avg(20),ma60=avg(60),trend=last?.close>ma20&&ma20>=ma60?'偏强':last?.close<ma20&&ma20<=ma60?'偏弱':'震荡',risk=[];if(q.pe!==null&&q.pe<0)risk.push('TTM市盈率为负');if(last?.changePct<=-7)risk.push('单日大幅下跌');if(q.turnoverRate>20)risk.push('换手率偏高');if(k.quality.amountCoveragePct<80)risk.push('历史K线成交额覆盖不足，避免据此判断量能');if(k.quality.turnoverCoveragePct<80)risk.push('历史K线换手率缺失，不应推断历史换手或主力资金');return{quote:q,kline:r.slice(-100),klineSource:k.source,klineFetchedAt:k.fetchedAt,klineAdjustment:k.adjustment,dataQuality:k.quality,...(k.warning?{dataWarning:k.warning}:{}),indicators:{ma5,ma20,ma60,trend},conclusion:{signal:trend==='偏强'?'持有/观察':trend==='偏弱'?'谨慎/等待':'区间观察',risk}}}
async function morning(db){if(!db)return{ok:false,reason:'DB not bound'};const hs=await listHoldings(db),t=now();for(const h of hs){const lv=h.pnlPct!=null&&h.pnlPct<-10?'HIGH':h.pnlPct!=null&&h.pnlPct<0?'MEDIUM':'INFO';await db.prepare('INSERT INTO alerts(code,level,title,detail,source,created_at) VALUES(?,?,?,?,?,?)').bind(h.code,lv,(h.name||h.code)+' 持仓晨报','当前盈亏 '+(h.pnlPct==null?'N/A':h.pnlPct.toFixed(2)+'%')+'；需结合趋势、资金、公告、基本面复核。','system',t).run()}return{ok:true,count:hs.length,createdAt:t}}
async function api(req,env){const u=new URL(req.url),p=u.pathname,db=env.DB;if(db)await init(db);if(p==='/api/health'){let ok=!!db;if(db)try{await db.prepare('SELECT 1').run()}catch{ok=false}return json({ok:true,db:ok,version:'0.2.0',time:now()})}if(p==='/api/quote'){const c=u.searchParams.get('code');try{const q=await quote(c);await health(db,'ok','quote',q.latencyMs);return json(q)}catch(e){await health(db,'error',e.message);return json({error:e.message},502)}}if(p==='/api/kline'){try{return json(await kline(u.searchParams.get('code'),+u.searchParams.get('limit')||120))}catch(e){return json({error:e.message},502)}}if(p==='/api/analyze'){try{return json(await analyze(u.searchParams.get('code')))}catch(e){return json({error:e.message},502)}}if(p==='/api/holdings'){if(req.method==='GET')return json(await listHoldings(db));if(req.method==='POST')try{return json(await addTrade(db,await req.json()),201)}catch(e){return json({error:e.message},400)}}if(p==='/api/alerts'){const r=await db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100').run();return json(r.results||[])}if(p==='/api/data-health'){const r=await db.prepare('SELECT * FROM data_health').run();return json(r.results||[])}if(p==='/api/settings'&&req.method==='POST'){const b=await req.json();await db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(String(b.key),JSON.stringify(b.value??''),now()).run();return json({ok:true})}if(p==='/api/cron/morning')return json(await morning(db));return env.ASSETS.fetch(req)}
export default{async fetch(req,env){return new URL(req.url).pathname.startsWith('/api/')?api(req,env):env.ASSETS.fetch(req)},async scheduled(e,env,ctx){ctx.waitUntil(morning(env.DB))}}
