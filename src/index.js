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
let schemaReady=false;async function init(db){if(db&&!schemaReady){for(const s of SCHEMA)await db.prepare(s).run();schemaReady=true}}
async function quote(code){
 code=String(code||'').trim();if(!/^\d{6}$/.test(code))throw Error('股票代码应为6位数字');
 const started=Date.now(),errors=[],n=(v,d=1)=>(v==null||v===''||v==='-')?null:(Number.isFinite(Number(v))?Number(v)/d:null);
 const sym=/^(6|688|5|9)/.test(code)?'sh'+code:'sz'+code;
 // Tencent is the proven quote source; response is GBK, so decode explicitly.
 try{
  const r=await fetch('https://qt.gtimg.cn/q='+sym,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'text/plain,*/*'},signal:AbortSignal.timeout(4000),cache:'no-store'});
  if(!r.ok)throw Error('HTTP '+r.status);
  const raw=new TextDecoder('gbk').decode(await r.arrayBuffer()),m=raw.match(/="([^"]*)"/),v=m?.[1]?.split('~');
  if(!v||v.length<38)throw Error('返回格式异常或字段不足');
  const price=n(v[3]),prevClose=n(v[4]);if(price==null||prevClose==null||price<=0)throw Error('缺少有效价格');
  return{source:'tencent',fetchedAt:now(),latencyMs:Date.now()-started,code,name:v[1]||code,price,prevClose,open:n(v[5]),high:n(v[33]),low:n(v[34]),volume:n(v[6])==null?null:n(v[6])*100,amount:n(v[37])==null?null:n(v[37])*10000,turnoverRate:n(v[38]),pe:n(v[39]),pb:n(v[46]),totalMarketCap:n(v[45])==null?null:n(v[45])*100000000,circulatingMarketCap:n(v[44])==null?null:n(v[44])*100000000};
 }catch(e){errors.push('腾讯行情: '+String(e?.message||e))}
 try{
  const u=new URL('https://push2.eastmoney.com/api/qt/stock/get');u.searchParams.set('secid',secid(code));u.searchParams.set('fields','f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168');u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');u.searchParams.set('_',String(Date.now()));
  const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(3000),cache:'no-store'});
  if(!r.ok)throw Error('HTTP '+r.status);const d=(await r.json())?.data;if(!d)throw Error('返回为空');
  const price=n(d.f43,100),prevClose=n(d.f60,100);if(price==null||prevClose==null)throw Error('缺少有效价格');
  return{source:'eastmoney-fallback',primaryError:errors.join('；'),fetchedAt:now(),latencyMs:Date.now()-started,code:d.f57||code,name:d.f58||code,price,open:n(d.f46,100),high:n(d.f44,100),low:n(d.f45,100),prevClose,volume:n(d.f47),amount:n(d.f48),turnoverRate:n(d.f168,100),pe:n(d.f162,100),pb:n(d.f167,100),totalMarketCap:n(d.f116),circulatingMarketCap:n(d.f117)};
 }catch(e){errors.push('东方财富行情: '+String(e?.message||e))}
 try{
  const r=await fetch('https://hq.sinajs.cn/list='+sym,{headers:{'user-agent':'Mozilla/5.0','referer':'https://finance.sina.com.cn/','accept':'text/plain,*/*'},signal:AbortSignal.timeout(3000),cache:'no-store'});
  if(!r.ok)throw Error('HTTP '+r.status);const raw=new TextDecoder('gbk').decode(await r.arrayBuffer()),m=raw.match(/="([^"]*)"/),v=m?.[1]?.split(',');
  if(!v||v.length<6||!v[0])throw Error('返回为空或格式异常');
  const price=n(v[3]),prevClose=n(v[2]);if(price==null||prevClose==null||price<=0)throw Error('缺少有效价格');
  return{source:'sina-fallback',primaryError:errors.join('；'),fetchedAt:now(),latencyMs:Date.now()-started,code,name:v[0]||code,price,prevClose,open:n(v[1]),high:n(v[4]),low:n(v[5]),volume:n(v[8]),amount:n(v[9]),turnoverRate:null,pe:null,pb:null,totalMarketCap:null,circulatingMarketCap:null};
 }catch(e){errors.push('新浪行情: '+String(e?.message||e))}
 throw Error('行情数据源均不可用。'+errors.join('；'));
}
async function fetchSinaKline(code,scale,count){
 const sym=/^(6|688|5|9)/.test(String(code))?'sh'+code:'sz'+code;
 const u=new URL('https://quotes.sina.cn/cn/api/jsonp_v2.php/CN_MarketData.getKLineData');
 u.searchParams.set('symbol',sym);u.searchParams.set('scale',String(scale));u.searchParams.set('ma','no');u.searchParams.set('datalen',String(count));
 const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://finance.sina.com.cn/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(5500),cache:'no-store'});
 if(!r.ok)throw Error('新浪 K线 HTTP '+r.status);
 const raw=await r.text(),m=raw.match(/\[[\s\S]*\]/);if(!m)throw Error('新浪接口未返回 JSON 数组');
 const arr=JSON.parse(m[0]);if(!Array.isArray(arr)||!arr.length)throw Error('新浪接口返回空数据');
 const num=v=>v==null||v===''||v==='-'?null:(Number.isFinite(Number(v))?Number(v):null);
 const rows=arr.map(p=>({date:p.day||p.date||p.d,open:num(p.open),close:num(p.close),high:num(p.high),low:num(p.low),volume:num(p.volume),amount:num(p.amount),turnover:null,changePct:null})).filter(x=>x.date&&x.open!=null&&x.close!=null&&x.high!=null&&x.low!=null);
 for(let i=0;i<rows.length;i++)if(i>0&&rows[i-1].close)rows[i].changePct=Number(((rows[i].close/rows[i-1].close-1)*100).toFixed(4));
 if(!rows.length)throw Error('新浪接口数据字段不完整');
 return rows;
}
async function kline(code,limit=120,mode='day'){
 code=String(code||'').trim();
 if(!/^\d{6}$/.test(code)) throw Error('股票代码应为6位数字');
 const intraday=mode==='intraday',count=intraday?240:Math.min(500,Math.max(20,Number.isFinite(+limit)?+limit:120));
 const safeNum=v=>{if(v===undefined||v===null||v===''||v==='-')return null;const n=Number(v);return Number.isFinite(n)?n:null};
 const withDerivedChanges=rows=>rows.map((row,i)=>({...row,changePct:row.changePct??(i>0&&rows[i-1].close?Number(((row.close/rows[i-1].close-1)*100).toFixed(4)):null)}));
 const quality=rows=>{const n=rows.length||1;return{rowCount:rows.length,amountCoveragePct:Math.round(rows.filter(x=>x.amount!=null).length/n*100),changePctCoveragePct:Math.round(rows.filter(x=>x.changePct!=null).length/n*100),turnoverCoveragePct:Math.round(rows.filter(x=>x.turnover!=null).length/n*100)}};
 const started=Date.now(), errors=[];
 if(intraday){
  // Try Eastmoney's historical 5-minute bars first; Sina is an independent fallback.
  try{
   const u=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
   u.searchParams.set('secid',secid(code));u.searchParams.set('fields1','f1,f2,f3,f4,f5,f6');u.searchParams.set('fields2','f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');u.searchParams.set('klt','5');u.searchParams.set('fqt','0');u.searchParams.set('end','20500101');u.searchParams.set('lmt','240');u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');u.searchParams.set('_',String(Date.now()));
   const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(6000),cache:'no-store'});
   if(!r.ok)throw Error('东方财富5分钟K线 HTTP '+r.status);
   const body=await r.json(),arr=body?.data?.klines||[];
   const rows=withDerivedChanges(arr.map(item=>{const p=String(item).split(',');return{date:p[0],open:safeNum(p[1]),close:safeNum(p[2]),high:safeNum(p[3]),low:safeNum(p[4]),volume:safeNum(p[5]),amount:safeNum(p[6]),changePct:safeNum(p[8]),turnover:safeNum(p[10])}}).filter(x=>x.date&&x.open!=null&&x.close!=null&&x.high!=null&&x.low!=null));
   if(!rows.length)throw Error('东方财富5分钟K线没有有效数据');
   return{source:'eastmoney-intraday-5m',mode:'intraday',interval:'5m',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:'none'};
  }catch(e){errors.push('东方财富5分钟K线: '+String(e?.message||e))}
  // Tencent intraday endpoint is the second fallback; unlike the Sina JSONP endpoint it returns ordinary JSON.
  try{
   const sym=/^(6|688|5|9)/.test(code)?'sh'+code:'sz'+code;
   const u=new URL('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline');
   u.searchParams.set('param',sym+',m5,,240');
   u.searchParams.set('_',String(Date.now()));
   const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(5000),cache:'no-store'});
   if(!r.ok)throw Error('腾讯5分钟K线 HTTP '+r.status);
   const body=await r.json(),node=body?.data?.[sym],arr=node?.m5||node?.m5v||[];
   const rows=withDerivedChanges(arr.map(p=>{const v=Array.isArray(p)?p:String(p||'').split(',');return{date:String(v[0]||''),open:safeNum(v[1]),close:safeNum(v[2]),high:safeNum(v[3]),low:safeNum(v[4]),volume:safeNum(v[5]),amount:safeNum(v[6]),changePct:null,turnover:null}}).filter(x=>x.date&&x.open!=null&&x.close!=null&&x.high!=null&&x.low!=null));
   if(!rows.length)throw Error('腾讯5分钟K线没有有效数据');
   return{source:'tencent-intraday-5m',mode:'intraday',interval:'5m',fetchedAt:now(),latencyMs:Date.now()-started,rows:rows.slice(-240),quality:quality(rows),adjustment:'unknown',warning:'东方财富5分钟K线不可用，已切换腾讯5分钟数据；部分成交额字段可能缺失。',primaryError:errors.join('；')};
  }catch(e){errors.push('腾讯5分钟K线: '+String(e?.message||e))}
  try{const rows=await fetchSinaKline(code,5,240);return{source:'sina-intraday-5m',mode:'intraday',interval:'5m',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:'unknown',warning:'东方财富与腾讯5分钟K线不可用，已切换新浪财经5分钟数据；盘中行情可能存在延迟。',primaryError:errors.join('；')}}catch(e){errors.push('新浪5分钟K线: '+String(e?.message||e))}
  throw Error('分时K线暂不可用：'+errors.join('；'));
}
 const headers={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'};
 // Eastmoney's historical K-line endpoint is push2his. push2delay is for delayed quotes and is not a K-line fallback.
 try{
  const u=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  u.searchParams.set('secid',secid(code));
  u.searchParams.set('fields1','f1,f2,f3,f4,f5,f6');
  u.searchParams.set('fields2','f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  u.searchParams.set('klt','101');
  u.searchParams.set('fqt','0');
  u.searchParams.set('end','20500101');
  u.searchParams.set('lmt',String(count));
  u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');
  u.searchParams.set('_',String(Date.now()));
  const r=await fetch(u,{headers,signal:AbortSignal.timeout(6500),cf:{cacheTtl:60,cacheEverything:false}});
  if(!r.ok)throw Error('Eastmoney HTTP '+r.status);
  const body=await r.json(), klines=body?.data?.klines||[];
  const rows=withDerivedChanges(klines.map(item=>{const p=String(item).split(',');return{date:p[0],open:safeNum(p[1]),close:safeNum(p[2]),high:safeNum(p[3]),low:safeNum(p[4]),volume:safeNum(p[5]),amount:safeNum(p[6]),changePct:safeNum(p[8]),turnover:safeNum(p[10])}}).filter(x=>x.date&&x.close!=null));
  if(!rows.length)throw Error('Eastmoney returned no valid K-line rows');
  return{source:'eastmoney-kline',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:'none'};
 }catch(e){errors.push('东方财富: '+String(e?.message||e))}
 // Keep the original Tencent parameter shape as a fallback; do not assume the qfqday field always exists.
 try{
  const sym=/^(6|688|5|9)/.test(code)?'sh'+code:'sz'+code;
  const u=new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
  u.searchParams.set('param',sym+',day,,,'+count+',');
  u.searchParams.set('_',String(Date.now()));
  const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('Tencent HTTP '+r.status);
  const body=await r.json(),node=body?.data?.[sym];
  const arr=node?.day||node?.qfqday||node?.hfqday||[];
  const rows=withDerivedChanges(arr.map(p=>({date:p[0],open:safeNum(p[1]),close:safeNum(p[2]),high:safeNum(p[3]),low:safeNum(p[4]),volume:safeNum(p[5]),amount:safeNum(p[6]),changePct:null,turnover:safeNum(p[7])})).filter(x=>x.date&&x.close!=null));
  if(!rows.length)throw Error('Tencent returned no valid K-line rows');
  return{source:'tencent-kline-fallback',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:node?.qfqday?'qfq':'none',warning:'东方财富 K 线暂不可用，已切换腾讯备用源；腾讯未提供的字段保持为空。',primaryError:errors.join('；')};
 }catch(e){errors.push('腾讯: '+String(e?.message||e))}
 // Independent third source for resilience if Eastmoney and Tencent fail.
 try{
  const sym=/^(6|688|5|9)/.test(code)?'sh'+code:'sz'+code;
  const u=new URL('https://quotes.sina.cn/cn/api/jsonp_v2.php/CN_MarketData.getKLineData');
  u.searchParams.set('symbol',sym);
  u.searchParams.set('scale','240');
  u.searchParams.set('ma','no');
  u.searchParams.set('datalen',String(count));
  const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://finance.sina.com.cn/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('Sina HTTP '+r.status);
  const raw=await r.text(),match=raw.match(/\[[\s\S]*\]/);if(!match)throw Error('Sina returned non-JSONP K-line response');
  const arr=JSON.parse(match[0]);
  const rows=withDerivedChanges(arr.map(p=>({date:p.day||p.date,open:safeNum(p.open),close:safeNum(p.close),high:safeNum(p.high),low:safeNum(p.low),volume:safeNum(p.volume),amount:safeNum(p.amount),changePct:null,turnover:null})).filter(x=>x.date&&x.close!=null));
  if(!rows.length)throw Error('Sina returned no valid K-line rows');
  return{source:'sina-kline-fallback',fetchedAt:now(),latencyMs:Date.now()-started,rows,quality:quality(rows),adjustment:'unknown',warning:'东方财富与腾讯 K 线暂不可用，已切换新浪备用源；复权方式及未提供字段可能不同。',primaryError:errors.join('；')};
 }catch(e){errors.push('新浪: '+String(e?.message||e))}
 throw Error('K线数据源均不可用。'+errors.join('；'));
}
async function health(db,source,status,detail,latency){if(db)await db.prepare('INSERT INTO data_health(source,status,latency_ms,checked_at,detail) VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET status=excluded.status,latency_ms=excluded.latency_ms,checked_at=excluded.checked_at,detail=excluded.detail').bind(source,status,latency||null,now(),detail||'').run()}
async function listHoldings(db){if(!db)return[];const r=await db.prepare('SELECT * FROM holdings WHERE shares>0 ORDER BY updated_at DESC').run();const out=[];for(const h of r.results||[]){let q=null;try{q=await quote(h.code)}catch{}const pnl=q?.price?(q.price-h.avg_cost)*h.shares:null;out.push({...h,quote:q,pnl,pnlPct:q?.price&&h.avg_cost?(q.price/h.avg_cost-1)*100:null,marketValue:q?.price?q.price*h.shares:null})}return out}
async function addTrade(db,b){const code=String(b.code||'').trim(),side=b.side==='SELL'?'SELL':'BUY',price=Number(b.price),shares=Number(b.shares),fee=Number(b.fee||0),t=now();if(!/^\\d{6}$/.test(code)||!Number.isFinite(price)||price<=0||!Number.isFinite(shares)||shares<=0||!Number.isFinite(fee)||fee<0)throw Error('请检查股票代码、价格、数量和费用');let h=await db.prepare('SELECT * FROM holdings WHERE code=? ORDER BY id LIMIT 1').bind(code).first();if(side==='SELL'&&(!h||Number(h.shares)<shares))throw Error('卖出数量超过当前持仓，不能卖空');if(!h){await db.prepare('INSERT INTO holdings(code,name,shares,avg_cost,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(code,b.name||code,shares,(price*shares+fee)/shares,b.note||'',t,t).run();h=await db.prepare('SELECT * FROM holdings WHERE code=? ORDER BY id DESC LIMIT 1').bind(code).first()}else{const os=Number(h.shares),oc=Number(h.avg_cost),ns=side==='BUY'?os+shares:os-shares,nc=side==='BUY'?((os*oc)+(shares*price)+fee)/ns:(ns>0?oc:0);await db.prepare('UPDATE holdings SET name=COALESCE(NULLIF(name,\'\'),?),shares=?,avg_cost=?,updated_at=? WHERE id=?').bind(b.name||code,ns,nc,t,h.id).run()}await db.prepare('INSERT INTO trades(holding_id,code,side,price,shares,fee,traded_at,note) VALUES(?,?,?,?,?,?,?,?)').bind(h.id,code,side,price,shares,fee,b.tradedAt||t,b.note||'').run();const finalHolding=await db.prepare('SELECT shares FROM holdings WHERE code=? ORDER BY id LIMIT 1').bind(code).first();return{ok:true,code,side,price,shares,amount:price*shares,fee,remainingShares:Math.max(0,Number(finalHolding?.shares||0))}}async function analyze(code){const [q,k]=await Promise.all([quote(code),kline(code)]),r=k.rows,last=r.at(-1),avg=n=>{const a=r.slice(-n).map(x=>x.close).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null},ma5=avg(5),ma20=avg(20),ma60=avg(60),trend=last?.close>ma20&&ma20>=ma60?'偏强':last?.close<ma20&&ma20<=ma60?'偏弱':'震荡',risk=[];if(q.pe!==null&&q.pe<0)risk.push('TTM市盈率为负');if(last?.changePct<=-7)risk.push('单日大幅下跌');if(q.turnoverRate>20)risk.push('换手率偏高');if(k.quality.amountCoveragePct<80)risk.push('历史K线成交额覆盖不足，避免据此判断量能');if(k.quality.turnoverCoveragePct<80)risk.push('历史K线换手率缺失，不应推断历史换手或主力资金');return{quote:q,kline:r.slice(-100),klineSource:k.source,klineFetchedAt:k.fetchedAt,klineLatencyMs:k.latencyMs,klinePrimaryError:k.primaryError,klineAdjustment:k.adjustment,dataQuality:k.quality,...(k.warning?{dataWarning:k.warning}:{}),indicators:{ma5,ma20,ma60,trend},conclusion:{signal:trend==='偏强'?'持有/观察':trend==='偏弱'?'谨慎/等待':'区间观察',risk}}}
async function morning(db){if(!db)return{ok:false,reason:'DB not bound'};const hs=await listHoldings(db),t=now();for(const h of hs){const lv=h.pnlPct!=null&&h.pnlPct<-10?'HIGH':h.pnlPct!=null&&h.pnlPct<0?'MEDIUM':'INFO';await db.prepare('INSERT INTO alerts(code,level,title,detail,source,created_at) VALUES(?,?,?,?,?,?)').bind(h.code,lv,(h.name||h.code)+' 持仓晨报','当前盈亏 '+(h.pnlPct==null?'N/A':h.pnlPct.toFixed(2)+'%')+'；需结合趋势、资金、公告、基本面复核。','system',t).run()}return{ok:true,count:hs.length,createdAt:t}}
async function getAIConfig(db){const rows=await db.prepare("SELECT key,value FROM app_settings WHERE key IN ('ai_endpoint','ai_api_key','ai_model')").run();const cfg={};for(const x of rows.results||[]){try{cfg[x.key]=JSON.parse(x.value)}catch{cfg[x.key]=x.value}}return cfg}
function completionURL(endpoint){const u=new URL(String(endpoint||'').trim());if(u.protocol!=='https:')throw Error('AI Endpoint 必须使用 HTTPS');u.hash='';let path=u.pathname;while(path.length>1&&path.endsWith('/'))path=path.slice(0,-1);if(path.toLowerCase().endsWith('/chat/completions')){u.pathname=path;return u.toString()}if(path==='/'||path===''){u.pathname='/chat/completions';return u.toString()}if(path.toLowerCase().endsWith('/v1')){u.pathname=path+'/chat/completions';return u.toString()}u.pathname=path+'/chat/completions';return u.toString()}
async function callAI(cfg,messages,timeout=30000,maxTokens=null){const endpoint=completionURL(cfg.ai_endpoint);const body={model:cfg.ai_model,temperature:0.2,stream:false,messages,thinking:{type:'disabled'}};if(Number.isFinite(maxTokens)&&maxTokens>0)body.max_tokens=maxTokens;let r;try{r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+cfg.ai_api_key},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)})}catch(e){if(e?.name==='TimeoutError'||e?.name==='AbortError'||String(e?.message||e).toLowerCase().includes('timeout'))throw Error('AI接口请求超时（等待 '+Math.round(timeout/1000)+' 秒）。已限制选股报告长度；请检查模型服务商响应速度/限流。');throw e}const raw=await r.text();if(!r.ok)throw Error('AI 服务返回 HTTP '+r.status+'（请求地址：'+endpoint+'）'+(raw?'：'+raw.slice(0,400):'；请检查 Endpoint 和模型权限'));let out;try{out=JSON.parse(raw)}catch{throw Error('AI 服务返回的不是有效 JSON：'+raw.slice(0,200))}const choice=out.choices?.[0]||out.output?.[0]||null;const msg=choice?.message||choice?.delta||choice;let content=msg?.content??out.output_text??out.response?.output_text??null;if(Array.isArray(content))content=content.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).filter(Boolean).join('\\n');if(content&&typeof content==='object')content=content.text||content.content||'';if(typeof content==='string'&&content.trim())return content.trim();const diag={responseKeys:Object.keys(out||{}).slice(0,12),choiceKeys:Object.keys(choice||{}).slice(0,12),messageKeys:Object.keys(msg||{}).slice(0,12),finishReason:choice?.finish_reason||choice?.finishReason||null,completionTokens:out.usage?.completion_tokens??out.usage?.output_tokens??null,reasoningTokens:out.usage?.completion_tokens_details?.reasoning_tokens??null,refusal:msg?.refusal||null,providerMessage:out.error?.message||out.message||null,rawPreview:JSON.stringify(out).slice(0,260)};throw Error('AI 服务已返回 HTTP '+r.status+'，但响应中没有可展示的正文。诊断：'+JSON.stringify(diag))}
async function quoteIndex(code){
 const started=Date.now(),errors=[],headers={'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'};
 const sec=(code==='000001'?'1.':'0.')+code;
 try{
  const u=new URL('https://push2.eastmoney.com/api/qt/stock/get');u.searchParams.set('secid',sec);u.searchParams.set('fields','f43,f44,f45,f46,f47,f48,f57,f58,f60');u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');
  const r=await fetch(u,{headers,signal:AbortSignal.timeout(3500),cache:'no-store'});if(!r.ok)throw Error('东方财富 HTTP '+r.status);
  const d=(await r.json())?.data;if(!d)throw Error('东方财富指数数据为空');
  const n=v=>v==null?null:Number(v)/100,price=n(d.f43),prevClose=n(d.f60);if(!(price>0&&prevClose>0))throw Error('东方财富指数点位字段无效');
  return{code,name:d.f58||code,price,open:n(d.f46),high:n(d.f44),low:n(d.f45),prevClose,changePct:(price/prevClose-1)*100,volume:d.f47==null?null:Number(d.f47),amount:d.f48==null?null:Number(d.f48),source:'eastmoney',fetchedAt:now(),latencyMs:Date.now()-started};
 }catch(e){errors.push('东方财富: '+String(e?.message||e))}
 const sym=(code==='000001'?'sh':'sz')+code;
 try{
  const r=await fetch('https://qt.gtimg.cn/q='+sym,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'text/plain,*/*'},signal:AbortSignal.timeout(4000),cache:'no-store'});if(!r.ok)throw Error('腾讯 HTTP '+r.status);
  const raw=new TextDecoder('gbk').decode(await r.arrayBuffer()),m=raw.match(/="([^"]*)"/),v=m?.[1]?.split('~');if(!v||v.length<6)throw Error('腾讯指数返回字段不足');
  const price=Number(v[3]),prevClose=Number(v[4]),open=Number(v[5]);if(!(price>0&&prevClose>0))throw Error('腾讯指数点位无效');
  return{code,name:v[1]||code,price,prevClose,open:Number.isFinite(open)?open:null,high:Number(v[33])||null,low:Number(v[34])||null,changePct:(price/prevClose-1)*100,volume:Number(v[6])*100||null,amount:Number(v[37])*10000||null,source:'tencent-index-fallback',fetchedAt:now(),latencyMs:Date.now()-started,primaryError:errors.join('；')};
 }catch(e){errors.push('腾讯: '+String(e?.message||e))}
 try{
  const sinaSym=(code==='000001'?'s_sh':'s_sz')+code;
  const r=await fetch('https://hq.sinajs.cn/list='+sinaSym,{headers:{'user-agent':'Mozilla/5.0','referer':'https://finance.sina.com.cn/','accept':'text/plain,*/*'},signal:AbortSignal.timeout(3500),cache:'no-store'});if(!r.ok)throw Error('新浪 HTTP '+r.status);
  const raw=new TextDecoder('gbk').decode(await r.arrayBuffer()),m=raw.match(/="([^"]*)"/),v=m?.[1]?.split(',');const price=Number(v?.[1]),changePct=Number(v?.[3]);
  if(!v||v.length<5||!(price>0)||!Number.isFinite(changePct))throw Error('新浪指数字段无效');
  return{code,name:v[0]||code,price,changePct,prevClose:null,open:null,high:null,low:null,volume:Number(v[4])||null,amount:Number(v[5])||null,source:'sina-index-fallback',fetchedAt:now(),latencyMs:Date.now()-started,primaryError:errors.join('；')};
 }catch(e){errors.push('新浪: '+String(e?.message||e))}
 throw Error('指数行情所有数据源均不可用：'+errors.join('；'));
}
async function fetchMarketLiquidity(){
 const headers={'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'},errors=[];
 const fs='m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
 for(const host of ['push2delay.eastmoney.com','push2.eastmoney.com']){
  try{
   const u=new URL('https://'+host+'/api/qt/clist/get');
   for(const [k,v] of Object.entries({pn:'1',pz:'5000',po:'1',np:'1',fltt:'2',invt:'2',fid:'f6',fs,fields:'f12,f14,f2,f3,f6,f8,f62',ut:'fa5fd1943c7b386f172d6893dbfba10b',_:String(Date.now())}))u.searchParams.set(k,v);
   const r=await fetch(u,{headers,signal:AbortSignal.timeout(5000),cache:'no-store'});if(!r.ok)throw Error(host+' HTTP '+r.status);
   const body=await r.json(),diff=body?.data?.diff,arr=Array.isArray(diff)?diff:(diff&&typeof diff==='object'?Object.values(diff):[]);
   if(arr.length<100)throw Error(host+' 全市场列表样本不足：'+arr.length);
   let advances=0,declines=0,unchanged=0,amount=0,flowKnown=0,flowNet=0,amountCount=0;
   for(const x of arr){const pct=Number(x.f3),amt=Number(x.f6),flow=x.f62==null||x.f62===''||x.f62==='-'?NaN:Number(x.f62);if(Number.isFinite(pct)){if(pct>0)advances++;else if(pct<0)declines++;else unchanged++;}if(Number.isFinite(amt)&&amt>0){amount+=amt;amountCount++;}if(Number.isFinite(flow)){flowKnown++;flowNet+=flow;}}
   if(!amountCount)throw Error(host+' 成交额字段无效');
   return{source:host,fetchedAt:now(),sampledStocks:arr.length,advances,declines,unchanged,advanceDeclineRatio:declines?Number((advances/declines).toFixed(3)):null,turnoverAmountSample:amount,amountCoverage:amountCount,flowKnownCount:flowKnown,flowNetAmountSample:flowKnown?flowNet:null,coverageNote:'这是接口返回样本统计，不冒充全市场完整成交额；用于市场宽度与流动性近似。'};
  }catch(e){errors.push(String(e?.message||e))}
 }
 return{source:null,error:errors.join('；'),coverageNote:'市场宽度/样本成交额抓取失败；不得将缺失值解释为市场流动性正常。'};
}
async function fetchSinaMarketNews(){
 const u=new URL('https://feed.mix.sina.com.cn/api/roll/get');
 for(const [k,v] of Object.entries({pageid:'153',lid:'2516',num:'30'}))u.searchParams.set(k,v);
 const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://finance.sina.com.cn/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(4500),cache:'no-store'});
 if(!r.ok)throw Error('新浪财经资讯 HTTP '+r.status);
 const body=await r.json(),arr=body?.result?.data||body?.data||[];
 if(!Array.isArray(arr))throw Error('新浪财经资讯返回格式异常');
 return arr.map(x=>({title:String(x.title||x.name||''),summary:String(x.intro||x.summary||x.content||''),url:String(x.url||x.link||''),publishedAt:x.ctime||x.intime||x.timestamp||null,source:'sina-finance'})).filter(x=>x.title).slice(0,25);
}
async function fetchScreenCandidates(){
 const headers={'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'};
 const errors=[];
 for(const host of ['push2delay.eastmoney.com','push2.eastmoney.com']){
  try{
   const u=new URL('https://'+host+'/api/qt/clist/get');
   for(const [k,v] of Object.entries({pn:'1',pz:'100',po:'1',np:'1',fltt:'2',invt:'2',fid:'f62',fs:'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',fields:'f12,f14,f2,f3,f5,f6,f7,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f62,f115',ut:'fa5fd1943c7b386f172d6893dbfba10b',_:String(Date.now())}))u.searchParams.set(k,v);
   const r=await fetch(u,{headers,signal:AbortSignal.timeout(4500),cache:'no-store'});if(!r.ok)throw Error(host+' HTTP '+r.status);
   const body=await r.json(),diff=body?.data?.diff,list=Array.isArray(diff)?diff:(diff&&typeof diff==='object'?Object.values(diff):[]);
   const rows=list.map(x=>({code:String(x.f12||''),name:String(x.f14||''),price:Number(x.f2),changePct:Number(x.f3),amount:Number(x.f6),turnover:Number(x.f8),pe:Number(x.f9),flow:x.f62==null||x.f62===''||x.f62==='-'?null:(Number.isFinite(Number(x.f62))?Number(x.f62):null),marketCap:Number(x.f20),rankSource:'eastmoney-money-flow-'+host})).filter(x=>/^\d{6}$/.test(x.code)&&x.name&&!x.name.includes('ST')&&x.price>0);
   if(!rows.length)throw Error(host+' 返回空列表或无效字段');
   return rows.slice(0,30);
  }catch(e){errors.push(String(e?.message||e))}
 }
 // Sina is a price/volume fallback only; it does not supply equivalent main-force net flow.
 const u=new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData');
 for(const [k,v] of Object.entries({page:'1',num:'100',sort:'amount',asc:'0',node:'hs_a',symbol:'',_:'1'}))u.searchParams.set(k,v);
 const r=await fetch(u,{headers:{...headers,'referer':'https://finance.sina.com.cn/'},signal:AbortSignal.timeout(5000),cache:'no-store'});
 if(!r.ok)throw Error('东方财富资金流排行备用集群失败（'+errors.join('；')+'）；新浪成交额榜 HTTP '+r.status);
 const raw=await r.text();let arr;try{arr=JSON.parse(raw)}catch{const m=raw.match(/\[[\s\S]*\]/);if(!m)throw Error('东方财富资金流排行失败（'+errors.join('；')+'）；新浪成交额榜格式异常');arr=JSON.parse(m[0])}
 if(!Array.isArray(arr)||!arr.length)throw Error('东方财富资金流排行失败（'+errors.join('；')+'）；新浪成交额榜为空');
 return arr.map(x=>({code:String(x.code||String(x.symbol||'').replace(/^(sh|sz)/,'')),name:String(x.name||''),price:Number(x.trade||x.price),changePct:Number(x.changepercent),amount:Number(x.amount),turnover:Number(x.turnoverratio),pe:null,flow:null,marketCap:null,rankSource:'sina-turnover-fallback',primaryError:errors.join('；')})).filter(x=>/^\d{6}$/.test(x.code)&&x.name&&!x.name.includes('ST')&&x.price>0).slice(0,30);
}

async function fetchStockFlowHistory(code){
 const headers={'user-agent':'Mozilla/5.0','referer':'https://data.eastmoney.com/','accept':'application/json,text/plain,*/*'},errors=[];
 const hosts=['push2delay.eastmoney.com','push2.eastmoney.com','push2his.eastmoney.com'];
 const parseHistory=body=>{
  const arr=body?.data?.klines;if(!Array.isArray(arr)||!arr.length)throw Error('资金流历史为空');
  const rows=arr.map(line=>{const p=String(line).split(',');return{date:p[0]||null,mainNetInflow:p[1]==null||p[1]===''?null:Number(p[1]),smallNetInflow:p[2]==null||p[2]===''?null:Number(p[2]),mediumNetInflow:p[3]==null||p[3]===''?null:Number(p[3]),largeNetInflow:p[4]==null||p[4]===''?null:Number(p[4]),superLargeNetInflow:p[5]==null||p[5]===''?null:Number(p[5]),mainNetInflowPct:p[6]==null||p[6]===''?null:Number(p[6]),unit:'CNY'}}).filter(x=>x.date&&Number.isFinite(x.mainNetInflow));
  if(!rows.length)throw Error('资金流历史没有有效主力净流入字段');
  return{rows,latest:rows.at(-1),cumulativeMainNetInflow:rows.reduce((sum,x)=>sum+x.mainNetInflow,0),historyDays:rows.length,period:rows.length>=5?'5-trading-days':'available-history',source:'eastmoney-stock-fflow-kline'};
 };
 for(const host of hosts){
  try{
   const u=new URL('https://'+host+'/api/qt/stock/fflow/kline/get');
   for(const [k,v] of Object.entries({secid:secid(code),fields1:'f1,f2,f3,f7',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',klt:'101',lmt:'5',ut:'fa5fd1943c7b386f172d6893dbfba10b',_:String(Date.now())}))u.searchParams.set(k,v);
   const r=await fetch(u,{headers,signal:AbortSignal.timeout(3200),cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
   const parsed=parseHistory(await r.json());return{...parsed,host};
  }catch(e){errors.push(host+': '+String(e?.message||e))}
 }
 // Current-day snapshot is an independent endpoint and must not be mistaken for multi-day history.
 for(const host of ['push2delay.eastmoney.com','push2.eastmoney.com']){
  try{
   const u=new URL('https://'+host+'/api/qt/stock/fflow/get');
   for(const [k,v] of Object.entries({secid:secid(code),fields:'f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f124,f125',ut:'fa5fd1943c7b386f172d6893dbfba10b',_:String(Date.now())}))u.searchParams.set(k,v);
   const r=await fetch(u,{headers,signal:AbortSignal.timeout(3200),cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
   const d=(await r.json())?.data;if(!d||d.f62==null||!Number.isFinite(Number(d.f62)))throw Error('当前主力净流入字段缺失');
   const row={date:null,retrievedAt:now(),mainNetInflow:Number(d.f62),mainNetInflowPct:d.f184==null?null:Number(d.f184),unit:'CNY',dateBasis:'接口未返回可确认的交易日期，不能据此声称是当日收盘数据'};
   return{rows:[row],latest:row,cumulativeMainNetInflow:row.mainNetInflow,historyDays:1,period:'snapshot-date-unverified',source:'eastmoney-stock-fflow-snapshot',historyUnavailable:errors.join('；'),host};
  }catch(e){errors.push(host+' 当前快照: '+String(e?.message||e))}
 }
 throw Error('个股资金流历史/快照接口均未通过有效性校验：'+errors.join('；'));
}

async function fetchFinancialSnapshot(code){
 const headers={'user-agent':'Mozilla/5.0','referer':'https://data.eastmoney.com/','accept':'application/json,text/plain,*/*'},errors=[];
 const market=/^(6|9)/.test(String(code))?'SH':'SZ',secucode=code+'.'+market;
 const mapRows=rows=>rows.map(x=>({reportDate:x.REPORT_DATE||x.REPORTDATE||x.QDATE||x.REPORT_DATE_NAME||null,noticeDate:x.NOTICE_DATE||x.NOTICEDATE||null,eps:x.BASIC_EPS??x.EPSJB??null,roe:x.WEIGHTAVG_ROE??x.ROEJQ??null,revenue:x.TOTAL_OPERATE_INCOME??x.TOTALOPERATEREVE??x.TOTAL_OPERATE_INCOME??null,revenueGrowthPct:x.TOTAL_OPERATE_INCOME_YOY??x.TOTALOPERATEREVETZ??x.YSTZ??null,netProfit:x.PARENT_NETPROFIT??x.PARENTNETPROFIT??x.NETPROFIT??null,netProfitGrowthPct:x.PARENT_NETPROFITTZ??x.PARENTNETPROFITTZ??x.SJLTZ??null,operatingCashFlowPerShare:x.MGJYXJJE??x.MGJYXJJE??null,debtAssetRatioPct:x.DEBT_ASSET_RATIO??x.ZCFZL??null,grossMarginPct:x.XSMLL??x.SALES_GROSS_PROFIT_RATIO??null}));
 const attempts=[
  {url:'https://datacenter-web.eastmoney.com/api/data/v1/get',params:{reportName:'RPT_LICO_FN_CPD',columns:'ALL',filter:'(SECURITY_CODE="'+code+'")',pageNumber:'1',pageSize:'5',sortColumns:'REPORTDATE',sortTypes:'-1',source:'WEB',client:'WEB'}},
  {url:'https://datacenter.eastmoney.com/securities/api/data/v1/get',params:{reportName:'RPT_F10_FINANCE_MAINFINADATA',columns:'ALL',filter:'(SECUCODE="'+secucode+'")',pageNumber:'1',pageSize:'5',sortColumns:'REPORT_DATE',sortTypes:'-1',source:'HSF10',client:'PC'}}
 ];
 for(const a of attempts){
  try{
   const u=new URL(a.url);for(const [k,v] of Object.entries({...a.params,_:String(Date.now())}))u.searchParams.set(k,v);
   const r=await fetch(u,{headers,signal:AbortSignal.timeout(4500),cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
   const body=await r.json(),rows=body?.result?.data;
   if(!Array.isArray(rows)||!rows.length)throw Error(body?.message||body?.msg||'返回空财务记录');
   const mapped=mapRows(rows);
   if(!mapped.some(x=>[x.eps,x.roe,x.revenue,x.netProfit,x.operatingCashFlowPerShare,x.debtAssetRatioPct].some(v=>v!=null&&Number.isFinite(Number(v)))))throw Error('返回记录中没有可用的核心财务数值字段');
   return{source:a.params.reportName,endpoint:a.url,fetchedAt:now(),rows:mapped,rawFieldSample:Object.keys(rows[0]||{}).slice(0,18)};
  }catch(e){errors.push(a.url+': '+String(e?.message||e))}
 }
 throw Error('财务摘要接口均未通过有效性校验：'+errors.join('；'));
}

async function fetchSectorFlowRanks(type='industry'){
 const headers={'user-agent':'Mozilla/5.0','referer':'https://data.eastmoney.com/','accept':'application/json,text/plain,*/*'},errors=[];
 const fs=type==='concept'?'m:90+t:3+f:!50':'m:90+t:2+f:!50';
 for(const host of ['push2delay.eastmoney.com','push2.eastmoney.com']){
  try{
   const u=new URL('https://'+host+'/api/qt/clist/get');
   for(const [k,v] of Object.entries({pn:'1',pz:'80',po:'1',np:'1',fltt:'2',invt:'2',fid:'f62',fs,fields:'f12,f14,f2,f3,f6,f62,f184',ut:'fa5fd1943c7b386f172d6893dbfba10b',_:String(Date.now())}))u.searchParams.set(k,v);
   const r=await fetch(u,{headers,signal:AbortSignal.timeout(3500),cache:'no-store'});if(!r.ok)throw Error(host+' HTTP '+r.status);
   const body=await r.json(),diff=body?.data?.diff,arr=Array.isArray(diff)?diff:(diff&&typeof diff==='object'?Object.values(diff):[]);
   if(!arr.length)throw Error(host+' 返回空板块列表');
   const rows=arr.map(x=>({code:String(x.f12||''),name:String(x.f14||''),changePct:x.f3==null?null:Number(x.f3),amount:x.f6==null?null:Number(x.f6),flow:x.f62==null||x.f62===''||x.f62==='-'?null:(Number.isFinite(Number(x.f62))?Number(x.f62):null),flowRatio:x.f184==null||x.f184===''?null:(Number.isFinite(Number(x.f184))?Number(x.f184):null),type,source:host})).filter(x=>x.code&&x.name);
   if(!rows.length)throw Error(host+' 返回记录缺少板块代码/名称');
   return rows;
  }catch(e){errors.push(String(e?.message||e))}
 }
 throw Error('板块资金流排行接口均不可用：'+errors.join('；'));
}

async function fetchStockBoards(code){
 const u=new URL('https://push2.eastmoney.com/api/qt/slist/get');
 u.searchParams.set('secid',secid(code));u.searchParams.set('spt','3');u.searchParams.set('fields','f12,f13,f14,f2,f3,f62');u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');
 const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(4000),cache:'no-store'});
 if(!r.ok)throw Error('个股所属板块 HTTP '+r.status);
 const body=await r.json(),d=body?.data?.diff??body?.data?.items??body?.data;
 const arr=Array.isArray(d)?d:(d&&typeof d==='object'?Object.values(d):[]);
 return arr.map(x=>({code:String(x.f12||''),name:String(x.f14||''),changePct:x.f3==null?null:Number(x.f3)})).filter(x=>x.code&&x.name);
}

async function fetchCninfoAnnouncements(code){
 const headers={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36','referer':'https://www.cninfo.com.cn/new/disclosure/stock?stockCode='+code,'origin':'https://www.cninfo.com.cn','content-type':'application/x-www-form-urlencoded; charset=UTF-8','accept':'application/json, text/plain, */*'};
 const isSH=/^(6|9)/.test(String(code)),isBJ=/^[48]/.test(String(code));
 const column=isBJ?'bjse':isSH?'sse':'szse',plate=isBJ?'bjse':isSH?(String(code).startsWith('688')?'shkcp':'shmb'):'szse';
 const body=new URLSearchParams({column,tabName:'fulltext',plate,stock:String(code),searchkey:'',secid:'',category:'',trade:'',seDate:'',sortName:'',sortType:'',pageNum:'1',pageSize:'12',isHLtitle:'true'});
 const r=await fetch('https://www.cninfo.com.cn/new/disclosure',{method:'POST',headers,body:body.toString(),signal:AbortSignal.timeout(5000),cache:'no-store'});
 if(!r.ok)throw Error('巨潮资讯公告 HTTP '+r.status);
 const d=await r.json(),arr=d?.announcements||d?.data?.announcements||[];
 if(!Array.isArray(arr))throw Error('巨潮资讯公告返回格式异常');
 const rows=arr.map(x=>({title:String(x.announcementTitle||x.title||''),date:x.announcementTime?new Date(Number(x.announcementTime)).toISOString().slice(0,10):String(x.noticeDate||''),company:String(x.secName||x.stockName||''),code:String(x.secCode||code),url:x.adjunctUrl?(String(x.adjunctUrl).startsWith('http')?String(x.adjunctUrl):'https://static.cninfo.com.cn/'+String(x.adjunctUrl)):('https://www.cninfo.com.cn/new/disclosure/stock?stockCode='+code),source:'巨潮资讯网（法定信息披露平台）'})).filter(x=>x.title);
 if(!rows.length)throw Error('巨潮资讯未返回该股票公告；可能是市场参数变化或接口限制');
 return{source:'cninfo',fetchedAt:now(),rows:rows.slice(0,12),officialPage:'https://www.cninfo.com.cn/new/disclosure/stock?stockCode='+code};
}
async function api(req,env){const u=new URL(req.url),p=u.pathname,db=env.DB;if(db&&p!=='/api/data-diagnostics')await init(db);if(p==='/api/data-diagnostics'){
 const quoteCrossCheck=async code=>{
  const [primary,secondary]=await Promise.all([
   quote(code).then(x=>({ok:true,...x})).catch(e=>({ok:false,error:String(e.message||e)})),
   (async()=>{const u=new URL('https://push2delay.eastmoney.com/api/qt/stock/get');for(const [k,v] of Object.entries({secid:secid(code),fields:'f43,f44,f45,f46,f47,f48,f57,f58,f60',ut:'fa5fd1943c7b386f172d6893dbfba10b',_:String(Date.now())}))u.searchParams.set(k,v);const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(3500),cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=(await r.json())?.data;if(!d||!(Number(d.f43)>0))throw Error('无有效行情字段');return{ok:true,source:'eastmoney-delay',price:Number(d.f43)/100,prevClose:d.f60==null?null:Number(d.f60)/100,amount:d.f48==null?null:Number(d.f48),name:d.f58||code,fetchedAt:now()};})().catch(e=>({ok:false,error:String(e.message||e)}))
  ]);
  const independent=primary.ok&&primary.source==='tencent'&&secondary.ok;
  const diff=independent&&secondary.price>0?Number((Math.abs(primary.price-secondary.price)/secondary.price*100).toFixed(4)):null;
  return{code,primary:{ok:primary.ok,source:primary.source||null,price:primary.price??null,prevClose:primary.prevClose??null,amount:primary.amount??null,error:primary.error||null},secondary,independent,priceDiffPct:diff,priceMatch:diff==null?null:diff<=0.5,rule:'独立来源价格差<=0.5%仅作为快照一致性检查，不代表资金流数据已被交叉验证。'};
 };
 const [candidates,liquidity,industry,concept,flowA,flowB,financeA,financeB,quoteA,quoteB]=await Promise.all([
  fetchScreenCandidates().then(x=>({ok:true,count:x.length,source:x[0]?.rankSource||null,flowFields:x.filter(y=>Number.isFinite(y.flow)).length,sample:x.slice(0,3).map(y=>({code:y.code,amount:y.amount,flow:y.flow,source:y.rankSource}))})).catch(e=>({ok:false,error:String(e.message||e)})),
  fetchMarketLiquidity().catch(e=>({error:String(e.message||e)})),
  fetchSectorFlowRanks('industry').then(x=>({ok:true,count:x.length,flowKnown:x.filter(y=>Number.isFinite(y.flow)).length,sample:x.slice(0,3)})).catch(e=>({ok:false,error:String(e.message||e)})),
  fetchSectorFlowRanks('concept').then(x=>({ok:true,count:x.length,flowKnown:x.filter(y=>Number.isFinite(y.flow)).length,sample:x.slice(0,3)})).catch(e=>({ok:false,error:String(e.message||e)})),
  fetchStockFlowHistory('600519').then(x=>({ok:true,...x})).catch(e=>({ok:false,error:String(e.message||e)})),
  fetchStockFlowHistory('000001').then(x=>({ok:true,...x})).catch(e=>({ok:false,error:String(e.message||e)})),
  fetchFinancialSnapshot('600519').then(x=>({ok:true,...x})).catch(e=>({ok:false,error:String(e.message||e)})),
  fetchFinancialSnapshot('000001').then(x=>({ok:true,...x})).catch(e=>({ok:false,error:String(e.message||e)})),
  quoteCrossCheck('600519'),
  quoteCrossCheck('000001')
 ]);
 return json({checkedAt:now(),candidates,liquidity,industry,concept,stockFlow:{'600519':flowA,'000001':flowB},financial:{'600519':financeA,'000001':financeB},quoteCrossCheck:{'600519':quoteA,'000001':quoteB},validation:{principle:'接口HTTP成功不等于数据有效；必须检查样本数量、字段、日期、数值和来源。价格快照可交叉比对；资金流、财务数据仍须以各自数据源的日期、字段与口径验证。'}})
};if(p==='/api/health'){let ok=!!db;if(db)try{await db.prepare('SELECT 1').run()}catch{ok=false}return json({ok:ok,db:ok,version:'0.3.1',time:now()})}if(p==='/api/quote'){const c=u.searchParams.get('code');try{const q=await quote(c);if(q.source==='tencent'){await health(db,'tencent','ok','Actual quote source: Tencent',q.latencyMs)}else{await health(db,'tencent','error','Primary source failed: '+(q.primaryError||'unavailable'),q.latencyMs);await health(db,q.source,'ok','Actual quote source: '+q.source,q.latencyMs)}return json(q)}catch(e){await health(db,'eastmoney','error',e.message);return json({error:e.message},502)}}if(p==='/api/kline'){try{const k=await kline(u.searchParams.get('code'),+u.searchParams.get('limit')||120,u.searchParams.get('mode')||'day');if(k.source.includes('fallback')||k.source.startsWith('sina-intraday')){await health(db,'eastmoney-kline','error','Primary K-line source failed: '+(k.primaryError||'unavailable'),k.latencyMs);await health(db,k.source,'ok','Actual K-line source: '+k.source,k.latencyMs)}else{await health(db,k.source,'ok','Actual K-line source: '+k.source,k.latencyMs)}return json(k)}catch(e){await health(db,'eastmoney-kline','error',e.message);return json({error:e.message},502)}}if(p==='/api/analyze'){try{const a=await analyze(u.searchParams.get('code'));if(a.quote.source==='tencent'){await health(db,'tencent','ok','Actual quote source: Tencent',a.quote.latencyMs)}else{await health(db,'tencent','error','Primary quote source failed: '+(a.quote.primaryError||'unavailable'),a.quote.latencyMs);await health(db,a.quote.source,'ok','Actual quote source: '+a.quote.source,a.quote.latencyMs)}if(a.klineSource.includes('fallback')){await health(db,'eastmoney-kline','error','Primary K-line source failed: '+(a.klinePrimaryError||'unavailable'),a.klineLatencyMs);await health(db,'tencent-kline-fallback','ok','Actual K-line source: Tencent fallback',a.klineLatencyMs)}else{await health(db,'eastmoney-kline','ok','Actual K-line source: '+a.klineSource,a.klineLatencyMs)}return json(a)}catch(e){await health(db,'eastmoney','error',e.message);return json({error:e.message},502)}}if(p==='/api/trades'){const code=u.searchParams.get('code');let r;if(code)r=await db.prepare('SELECT * FROM trades WHERE code=? ORDER BY traded_at DESC,id DESC LIMIT 200').bind(code).run();else r=await db.prepare('SELECT * FROM trades ORDER BY traded_at DESC,id DESC LIMIT 200').run();return json(r.results||[])}if(p==='/api/holdings'){if(req.method==='GET')return json(await listHoldings(db));if(req.method==='POST')try{return json(await addTrade(db,await req.json()),201)}catch(e){return json({error:e.message},400)}}if(p==='/api/alerts'){const r=await db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100').run();return json(r.results||[])}if(p==='/api/data-health'){const r=await db.prepare('SELECT * FROM data_health').run();return json(r.results||[])}if(p==='/api/settings'&&req.method==='GET'){const r=await db.prepare("SELECT key,value FROM app_settings WHERE key IN ('ai_endpoint','ai_api_key','ai_model')").run();const cfg={};for(const x of r.results||[]){try{cfg[x.key]=JSON.parse(x.value)}catch{cfg[x.key]=x.value}}return json({endpoint:cfg.ai_endpoint||'https://api.openai.com/v1/chat/completions',model:cfg.ai_model||'',configured:!!(cfg.ai_endpoint&&cfg.ai_api_key&&cfg.ai_model),hasKey:!!cfg.ai_api_key})}if(p==='/api/settings'&&req.method==='POST'){const b=await req.json();const allowed=new Set(['ai_endpoint','ai_api_key','ai_model']);if(!allowed.has(b.key))return json({error:'不允许修改此配置项'},400);const value=String(b.value??'').trim();if(b.key==='ai_endpoint'){let z;try{z=new URL(value)}catch{return json({error:'Endpoint 必须是有效的 HTTPS URL'},400)}if(z.protocol!=='https:')return json({error:'Endpoint 必须使用 HTTPS'},400)}if(value.length>2000)return json({error:'配置值过长'},400);await db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(b.key,JSON.stringify(value),now()).run();return json({ok:true})}if(p==='/api/ai/analyze'&&req.method==='POST'){
 const b=await req.json().catch(()=>({})),code=String(b.code||'').trim(),cfg=await getAIConfig(db);
 if(!cfg.ai_endpoint||!cfg.ai_api_key||!cfg.ai_model)return json({error:'请先在设置中配置 AI Endpoint、API Key 和 Model'},400);
 const started=Date.now();
 try{
  if(!/^\\d{6}$/.test(code))throw Error('股票代码应为6位数字');
  const [qResult,kResult,newsResult,financeResult,flowResult]=await Promise.all([
   quote(code).then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)})),
   kline(code,120,'day').then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)})),
   fetchSinaMarketNews().then(data=>({data,error:null})).catch(e=>({data:[],error:String(e.message||e)})),
   fetchFinancialSnapshot(code).then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)})),
   fetchStockFlowHistory(code).then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)}))
  ]);
  if(!qResult.data)throw Error('实时行情不可用，不能安全生成个股分析：'+qResult.error);
  const q=qResult.data,k=kResult.data,rows=k?.rows||[],last=rows.at(-1);
  const avg=n=>{const z=rows.slice(-n).map(x=>x.close).filter(Number.isFinite);return z.length?z.reduce((a,v)=>a+v,0)/z.length:null};
  const ma20=avg(20),ma60=avg(60),ma5=avg(5);
  const relatedNews=(newsResult.data||[]).filter(x=>((x.title||'')+' '+(x.summary||'')).includes(code)||(q.name&&((x.title||'')+' '+(x.summary||'')).includes(q.name)));
  const [boardsResult,industryResult,conceptResult,cninfoResult]=await Promise.all([
   fetchStockBoards(code).then(data=>({data,error:null})).catch(e=>({data:[],error:String(e.message||e)})),
   fetchSectorFlowRanks('industry').then(data=>({data,error:null})).catch(e=>({data:[],error:String(e.message||e)})),
   fetchSectorFlowRanks('concept').then(data=>({data,error:null})).catch(e=>({data:[],error:String(e.message||e)})),
   fetchCninfoAnnouncements(code).then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)}))
  ]);
  const sectorMap=new Map([...industryResult.data,...conceptResult.data].map(x=>[x.code,x]));
  const boards=(boardsResult.data||[]).map(x=>({...x,sectorFlow:sectorMap.get(x.code)||null}));
  const a={
   quote:q,kline:rows.slice(-120),klineSource:k?.source||null,klineFetchedAt:k?.fetchedAt||null,klineLatencyMs:k?.latencyMs||null,klineError:kResult.error,
   klineAdjustment:k?.adjustment||'unknown',klineQuality:k?.quality||null,klineWarning:k?.warning||null,
   indicators:{ma5,ma20,ma60,trend:last&&ma20!=null&&ma60!=null?(last.close>ma20&&ma20>=ma60?'偏强':last.close<ma20&&ma20<=ma60?'偏弱':'震荡/待确认'):'技术趋势数据不足'},
   financialSnapshot:financeResult.data,financialError:financeResult.error,
   fundFlow:flowResult.data,fundFlowError:flowResult.error,
   sectorContext:{boards,boardMembershipError:boardsResult.error,industryFlowSource:industryResult.data[0]?.source||null,industryFlowError:industryResult.error,conceptFlowSource:conceptResult.data[0]?.source||null,conceptFlowError:conceptResult.error},
   officialAnnouncements:cninfoResult.data,officialAnnouncementsError:cninfoResult.error,
   relatedNews,recentMarketNews:(newsResult.data||[]).slice(0,8),newsFetchError:newsResult.error,
   dataCompleteness:{
    quote:!!q,validDailyBars:rows.length,hasAtLeast20DailyBars:rows.length>=20,
    amountCoveragePct:k?.quality?.amountCoveragePct??null,
    financialSnapshot:!!financeResult.data?.rows?.length,
    fundFlowHistory:!!flowResult.data?.rows?.length,
    officialAnnouncements:!!cninfoResult.data?.rows?.length,
    relatedNewsCount:relatedNews.length,
    boardCount:boards.length,
    missing:[...(kResult.error?['日K线抓取失败']:[]),...(rows.length<20?['有效日K不足20根']:[]),...(financeResult.error?['财务摘要缺失']:[]),...(flowResult.error?['个股资金流缺失']:[]),...(cninfoResult.error?['官方公告抓取失败']:[]),...(boardsResult.error?['行业/概念归属抓取失败']:[]),...(relatedNews.length===0?['个股相关新闻未命中']:[])]
   }
  };
  const content=await callAI(cfg,[
   {role:'system',content:'你是严谨的中国A股研究与风险控制分析师。必须基于输入数据，不得把缺失值当作0或正常，不得编造新闻、公告、行业归属、财务指标、机构持仓、股东变化、质押、龙虎榜或支撑位。先区分已核验事实、数据源线索、分析推断和缺失项。财务数据必须注明报告期；资金流必须注明来源、日期/期间和单位，接口快照日期不明时不得称为“今日净流入”。公告列表是标题线索，不代表已读公告全文；对重大事项必须给出官方公告链接并提示打开原文复核。新闻只可使用明确相关的标题/摘要，泛财经新闻不能当作个股证据。对“亏损原因”仅可引用业绩公告/财报明确披露的原因；没有原文证据则写“待核实”。输出简体中文，包含：1结论摘要；2主营业务与行业；3最新财务表现及亏损原因（有数据才分析）；4估值与安全边际（字段不足时不估算）；5日K技术面和量价（amount为空则禁止分析成交额/量能）；6资金流与板块环境；7官方公告/相关新闻；8机构持仓、龙虎榜、股东增减持/质押等数据状态；9主要风险与条件式操作计划；10数据来源、时间、质量和待核验清单。明确这不是确定性交易指令，不承诺收益。'},
   {role:'user',content:'请分析A股个股 '+code+'。以下是后端实际抓取数据；null/空数组表示缺失，不得补猜。'+JSON.stringify({generatedAt:now(),analysis:a,financialSnapshot:a.financialSnapshot,financialError:a.financialError,fundFlow:a.fundFlow,fundFlowError:a.fundFlowError,sectorContext:a.sectorContext,officialAnnouncements:a.officialAnnouncements,officialAnnouncementsError:a.officialAnnouncementsError,relatedNews:a.relatedNews,recentMarketNews:a.recentMarketNews,newsFetchError:a.newsFetchError,importantDataPolicy:'当前没有接入可验证的机构持仓、龙虎榜明细、股东增减持/质押结构化历史；不要声称已查到。请把巨潮公告标题作为待核验线索，不要当作公告全文。'} )}
  ],65000,5000);
  const created=now();
  await db.prepare('INSERT INTO reports(code,report_type,payload,created_at) VALUES(?,?,?,?)').bind(code,'ai_analysis',JSON.stringify({model:cfg.ai_model,content,generatedAt:created,source:a}),created).run();
  return json({ok:true,code,model:cfg.ai_model,generatedAt:created,content,ruleAnalysis:a,elapsedMs:Date.now()-started});
 }catch(e){return json({error:String(e.message||e),stage:'个股AI分析：抓取/校验/生成',elapsedMs:Date.now()-started},502)}
}if(p==='/api/ai/screen'&&req.method==='POST'){
 const cfg=await getAIConfig(db);
 if(!cfg.ai_endpoint||!cfg.ai_api_key||!cfg.ai_model)return json({error:'请先在设置中配置 AI Endpoint、API Key 和 Model'},400);
 const started=Date.now();let stage='读取候选行情、指数和资讯';
 try{
  const [candidates,market,newsResult,liquidityResult]=await Promise.all([
   fetchScreenCandidates(),
   Promise.all(['000001','399001','399006'].map(async code=>{try{return await quoteIndex(code)}catch(e){return{code,error:String(e.message||e)}}})),
   fetchSinaMarketNews().then(items=>({items,error:null})).catch(e=>({items:[],error:String(e.message||e)})),
   fetchMarketLiquidity().catch(e=>({source:null,error:String(e.message||e)}))
  ]);
  if(!candidates.length)throw Error('没有取得有效候选股行情，请稍后重试');
  stage='筛选候选股并核验近5日资金流';
  // First rank by observable liquidity, net flow, valuation availability and overheating risk.
  const ranked=candidates.map(c=>{
   const flowKnown=Number.isFinite(c.flow),peKnown=Number.isFinite(c.pe)&&c.pe>0;
   const ch=Number.isFinite(c.changePct)?c.changePct:0,turn=Number.isFinite(c.turnover)?c.turnover:0;
   let score=0;
   if(flowKnown)score+=c.flow>0?3:c.flow<0?-4:0;else score-=1;
   if(peKnown)score+=c.pe<=25?2:c.pe<=40?1:c.pe>80?-2:0;else score-=0.5;
   if(ch>=-2&&ch<=3)score+=2;else if(ch>6)score-=3;else if(ch< -5)score-=2;
   if(turn>=0.5&&turn<=8)score+=1.5;else if(turn>15)score-=2;
   if(Number.isFinite(c.amount)&&c.amount>300000000)score+=1;
   return {...c,preScore:Number(score.toFixed(2))};
  }).sort((a,b)=>b.preScore-a.preScore);
  const flowChecked=await Promise.all(ranked.slice(0,5).map(async c=>{
   try{return {...c,flowHistory:await fetchStockFlowHistory(c.code),flowHistoryError:null}}
   catch(e){return {...c,flowHistory:null,flowHistoryError:String(e.message||e)}}
  }));
  const flowPositive=flowChecked.filter(c=>c.flowHistory?.latest?.mainNetInflow>0&&c.changePct<6&&(!Number.isFinite(c.pe)||c.pe>0))
   .sort((a,b)=>(b.flowHistory.cumulativeMainNetInflow||0)-(a.flowHistory.cumulativeMainNetInflow||0));
  const chosen=(flowPositive.length>=3?flowPositive:flowChecked.filter(c=>c.flowHistory).length>=3?flowChecked.filter(c=>c.flowHistory).sort((a,b)=>(b.flowHistory?.cumulativeMainNetInflow||-Infinity)-(a.flowHistory?.cumulativeMainNetInflow||-Infinity)):ranked).slice(0,3);
  stage='读取最终候选股行情和日K线';
  // Fetch actual quote + daily bars for only the three finalists, avoiding the old high fan-out pattern.
  const results=await Promise.all(chosen.map(async c=>{
   const [qResult,kResult,finResult]=await Promise.all([
    quote(c.code).then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)})),
    kline(c.code,120,'day').then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)})),
    fetchFinancialSnapshot(c.code).then(data=>({data,error:null})).catch(e=>({data:null,error:String(e.message||e)}))
   ]);
   const q=qResult.data||{code:c.code,name:c.name,price:c.price,changePct:c.changePct,source:c.rankSource,pe:c.pe,turnoverRate:c.turnover,amount:c.amount};
   const k=kResult.data,rows=k?.rows||[],last=rows.at(-1);
   const avg=n=>{const a=rows.slice(-n).map(x=>x.close).filter(Number.isFinite);return a.length?a.reduce((sum,x)=>sum+x,0)/a.length:null};
   const sliceN=rows.slice(-20),low20=sliceN.length?Math.min(...sliceN.map(x=>x.low).filter(Number.isFinite)):null,high20=sliceN.length?Math.max(...sliceN.map(x=>x.high).filter(Number.isFinite)):null;
   const ret=(n)=>rows.length>n&&rows[rows.length-n-1]?.close?Number(((last.close/rows[rows.length-n-1].close-1)*100).toFixed(2)):null;
   const closes=rows.slice(-20).map(x=>x.close).filter(Number.isFinite);
   const peakDrawdown=closes.length?Number((Math.min(...closes.map((v,i)=>v/Math.max(...closes.slice(0,i+1))-1))*100).toFixed(2)):null;
   const ma5=avg(5),ma20=avg(20),ma60=avg(60);
   const trend=last&&ma20!=null&&ma60!=null?(last.close>ma20&&ma20>=ma60?'偏强':last.close<ma20&&ma20<=ma60?'偏弱':'震荡/待确认'):'技术趋势数据不足';
   const analysis={quote:q,klineSource:k?.source||null,klineFetchedAt:k?.fetchedAt||null,klineError:kResult.error,indicators:{ma5,ma20,ma60,trend,return5dPct:ret(5),return20dPct:ret(20),low20,high20,drawdown20dPct:peakDrawdown},fundFlowHistory:c.flowHistory||null,flowHistoryError:c.flowHistoryError||null,flowSnapshot:Number.isFinite(c.flow)?{date:null,retrievedAt:now(),mainNetInflow:c.flow,unit:'CNY',period:'ranking-snapshot-date-unverified',source:c.rankSource}:null,financialSnapshot:finResult.data,financialSnapshotError:finResult.error,dataQuality:{flowKnown:(!!c.flowHistory?.latest&&Number.isFinite(c.flowHistory.latest.mainNetInflow))||Number.isFinite(c.flow),flowSource:c.flowHistory?.source||c.rankSource,flowPeriod:c.flowHistory?.period||(Number.isFinite(c.flow)?'current-day-ranking-snapshot':null),flowHistoryDays:c.flowHistory?.historyDays||0,financialStatementsAvailable:!!finResult.data?.rows?.length,sectorFlowMatched:false},conclusion:{signal:trend==='偏强'?'观察回踩/放量确认':trend==='偏弱'?'等待止跌和趋势修复':'等待支撑确认',risk:[...(c.flow==null?['个股主力资金流缺失或数据源不支持']:[]),...(qResult.error?['独立实时行情获取失败，采用资金流榜快照']:[]),...(kResult.error?['日K线获取失败，无法可靠计算支撑位']:[])]}};
   return {...c,ok:true,analysis};
  }));
  stage='读取候选股所属板块及板块资金流';
  const [sectorRanks,boardResults]=await Promise.all([
   Promise.all(['industry','concept'].map(async type=>{try{return await fetchSectorFlowRanks(type)}catch(e){return {error:String(e.message||e),type,items:[]}}})),
   Promise.all(chosen.map(async c=>{try{return {code:c.code,boards:await fetchStockBoards(c.code),error:null}}catch(e){return {code:c.code,boards:[],error:String(e.message||e)}}}))
  ]);
  const sectorByCode=new Map(sectorRanks.flatMap(x=>Array.isArray(x)?x:[]).map(x=>[x.code,x]));
  for(const item of results){
   const boardData=boardResults.find(x=>x.code===item.code);
   const boards=boardData?.boards||[];
   item.sectorContext={boards:boards.map(b=>({...b,flowRank:sectorByCode.get(b.code)?.flow??null,flowRatio:sectorByCode.get(b.code)?.flowRatio??null,sectorChangePct:sectorByCode.get(b.code)?.changePct??b.changePct??null,flowSource:sectorByCode.has(b.code)?'eastmoney-sector-flow-ranking':'membership-only'})),membershipError:boardData?.error||null,sectorFlowUnavailable:sectorRanks.some(x=>!Array.isArray(x))};
  }
  const good=results.filter(x=>x.ok);
  if(!good.length)throw Error('三只候选股均未能完成基础数据核验');
   const indexCount=market.filter(x=>x&&Number.isFinite(x.price)&&x.price>0).length;
   const quoteCount=good.filter(x=>Number.isFinite(x.analysis.quote?.price)&&x.analysis.quote.price>0).length;
   const klineCount=good.filter(x=>x.analysis.indicators?.ma20!=null).length;
   const flowCount=good.filter(x=>x.analysis.dataQuality?.flowKnown).length;
   const financeCount=good.filter(x=>x.analysis.dataQuality?.financialStatementsAvailable).length;
   const flowErrors=good.map(x=>x.analysis.flowHistoryError).filter(Boolean).slice(0,3).join(' | ');
   const financeErrors=good.map(x=>x.analysis.financialSnapshotError).filter(Boolean).slice(0,3).join(' | ');
   if(indexCount<2||quoteCount<3||klineCount<2||flowCount<2||financeCount<2)throw Error('基础数据质量门槛未通过，暂不生成误导性报告。可用数据：指数 '+indexCount+'/3，个股实时行情 '+quoteCount+'/3，至少20日有效日K '+klineCount+'/3，个股资金流（历史或当日快照） '+flowCount+'/3，财务摘要 '+financeCount+'/3。资金流错误：'+(flowErrors||'无')+'。财务错误：'+(financeErrors||'无')+'。市场流动性源：'+(liquidityResult.error||liquidityResult.source||'未知')+'。');
  const payload={
   generatedAt:now(),elapsedMs:Date.now()-started,marketIndices:market,marketLiquidity:liquidityResult,
   marketNews:newsResult.items.slice(0,12),newsFetchError:newsResult.error,
   selectionMethod:'资金流优先 + 估值字段可用性 + 涨幅不过热 + 换手率/成交额 + 日K趋势/回撤复核',
   candidates:good.map(x=>({
    stock:{code:x.code,name:x.name,price:x.analysis.quote.price,changePct:x.changePct,amount:x.amount,turnover:x.turnover,pe:x.analysis.quote.pe??x.pe,pb:x.analysis.quote.pb??null,flow:x.flow,flowSource:x.analysis.fundFlowHistory?.source||x.rankSource,flowHistory:x.analysis.fundFlowHistory,flowHistoryError:x.analysis.flowHistoryError,flowPeriod:x.analysis.fundFlowHistory?.period||null,financialSnapshot:x.analysis.financialSnapshot||null,financialSnapshotError:x.analysis.financialSnapshotError||null,preScore:x.preScore},
    technical:x.analysis.indicators,klineSource:x.analysis.klineSource,klineError:x.analysis.klineError,
    sectorContext:x.sectorContext,dataQuality:x.analysis.dataQuality
   })),
   limitations:[
    '已新增东方财富财务摘要接口，尝试读取最近5期报告的营收、净利润、ROE、每股经营现金流及资产负债率；若该接口不可用，相关指标必须标记缺失，不能推断为正常。完整财报附注与历史估值分位仍需另行核验。',
    '已尝试抓取候选股所属行业/概念板块和板块当日资金流排名；如果接口失败或未匹配到板块，必须标记缺失。当前板块流向为当日快照，尚不能证明资金连续多日增加。',
    '新闻为市场资讯流；仅可将标题/摘要明确相关的内容作为线索，不能声称已完成公告原文核验。',
    '若候选股资金流字段为空或来自新浪涨幅榜，必须标记未知，不得推断为净流入。'
   ]
  };
  stage='调用AI生成选股报告';
  const compactPayload={...payload,marketNews:payload.marketNews.slice(0,6),candidates:payload.candidates.map(x=>({...x,stock:{...x.stock,flowHistory:x.stock.flowHistory?{rows:(x.stock.flowHistory.rows||[]).slice(-5),latest:x.stock.flowHistory.latest,cumulativeMainNetInflow:x.stock.flowHistory.cumulativeMainNetInflow,historyDays:x.stock.flowHistory.historyDays,period:x.stock.flowHistory.period,source:x.stock.flowHistory.source}:null},sectorContext:{...x.sectorContext,boards:(x.sectorContext?.boards||[]).slice(0,3)}}))};
  const content=await callAI(cfg,[
   {role:'system',content:'你是严谨的A股量化研究与风险控制团队。报告必须紧凑：总长度不超过约1800个汉字，每只股票不超过450字，避免长篇泛论。只根据输入数据，不得编造公司、行业归属、财报、资金流、新闻、价格或技术指标。最终必须给出恰好3只股票，按建仓观察优先级1-3排序；如果数据不足以支持三只合格标的，明确标注“观察名单/暂不建仓”，不得为凑数虚构确定性。每只必须分项说明：所属板块（只有有证据时才写；否则写待核实）、题材催化和新闻证据及关联程度、板块资金趋势（缺失则明确）、个股主力资金流单位为人民币元。必须区分5日历史与快照；只有5日历史可报告5日合计。快照若接口未给可确认交易日期，必须标注日期未核实与抓取时间，不得写成今日流入。必须给出source/host/日期依据/单位。板块资金流必须给出接口来源、板块代码、当日净流入与成交额；接口失败则明确未知。估值与基本面（区分可验证数据与缺失项）、未过度炒作证据、量价/均线/近20日区间和回撤、主要风险、建仓优先级。建仓操作必须给出基于现价和真实日K支撑/均线的条件式区间：首笔观察仓、回踩加仓条件、突破跟随条件、失效/止损条件；若K线或支撑数据缺失，不得编造具体价格，改用等待数据的条件。优先寻找正向资金、板块资金改善、基本面支撑、低拥挤且估值有安全边际的个股；若输入无法证明其中某项，要把它列为未验证而非给高分。明确避免追高，不能承诺收益。开头先总结市场环境和风险偏好，再列出三只股票，结尾列出本轮筛选数据缺口与下一步核验清单。'},
   {role:'user',content:JSON.stringify(compactPayload)}
  ],70000,4000);
  stage='保存选股报告';
  const created=now();
  await db.prepare('INSERT INTO reports(code,report_type,payload,created_at) VALUES(?,?,?,?)').bind(null,'ai_screen',JSON.stringify({model:cfg.ai_model,content,results:good,market,generatedAt:created,selectionMethod:payload.selectionMethod,limitations:payload.limitations}),created).run();
  return json({ok:true,model:cfg.ai_model,generatedAt:created,content,results:good,market,selectionMethod:payload.selectionMethod,limitations:payload.limitations,elapsedMs:Date.now()-started});
 }catch(e){return json({error:String(e.message||e),stage,elapsedMs:Date.now()-started},502)}
}if(p==='/api/ai/holdings-report'&&req.method==='POST'){const cfg=await getAIConfig(db);if(!cfg.ai_endpoint||!cfg.ai_api_key||!cfg.ai_model)return json({error:'请先在设置中配置 AI Endpoint、API Key 和 Model'},400);try{const hs=await db.prepare('SELECT * FROM holdings WHERE shares>0 ORDER BY updated_at DESC').run();if(!hs.results?.length)return json({error:'当前没有有效持仓，先在个股页面录入买入交易'},400);const data=await Promise.all(hs.results.map(async h=>{let current;try{current=await analyze(h.code)}catch(e){current={error:String(e.message||e)}}const trades=await db.prepare('SELECT side,price,shares,fee,traded_at,note FROM trades WHERE code=? ORDER BY traded_at ASC,id ASC').bind(h.code).run();return{holding:h,marketAndTechnical:current,trades:trades.results||[]}}));const content=await callAI(cfg,[{role:'system',content:'你是严谨的中国A股持仓风险管理分析师。根据持仓数量、成本、完整交易流水和当前行情技术数据，输出组合总览、逐股优先级、浮动盈亏与风险、趋势情景预测（必须是条件情景而非确定预测）、继续持有/减仓/止损观察/分批加仓的条件式计划、关键价格观察区间和触发条件。没有足够数据的新闻/公告/板块资金/宏观消息必须列为缺失，不得编造。明确说明不构成确定性交易指令。'},{role:'user',content:JSON.stringify({generatedAt:now(),positions:data})}],45000);const created=now();await db.prepare('INSERT INTO reports(code,report_type,payload,created_at) VALUES(?,?,?,?)').bind(null,'holdings_report',JSON.stringify({model:cfg.ai_model,content,data,generatedAt:created}),created).run();return json({ok:true,model:cfg.ai_model,content,data,generatedAt:created})}catch(e){return json({error:String(e.message||e)},502)}}if(p==='/api/cron/morning')return json(await morning(db));return env.ASSETS.fetch(req)}
export default{async fetch(req,env){const u=new URL(req.url),isApi=u.pathname.startsWith('/api/');try{return isApi?await api(req,env):await env.ASSETS.fetch(req)}catch(e){const detail=String(e?.message||e);return isApi?json({error:'Worker未处理异常',detail,path:u.pathname},500):new Response('Worker internal error',{status:500,headers:{'content-type':'text/plain;charset=utf-8'}})}},async scheduled(e,env,ctx){ctx.waitUntil(morning(env.DB))}}
