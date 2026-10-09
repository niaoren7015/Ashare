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
   const u=new URL('https://web.ifzq.gtimg.cn/appstock/app/kline/mkline');
   u.searchParams.set('param',sym+',m5,,240');
   u.searchParams.set('_',String(Date.now()));
   const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','referer':'https://gu.qq.com/','accept':'application/json,text/plain,*/*'},signal:AbortSignal.timeout(5000),cache:'no-store'});
   if(!r.ok)throw Error('腾讯5分钟K线 HTTP '+r.status);
   const body=await r.json(),node=body?.data?.[sym],arr=node?.m5||node?.m5v||[];
   const rows=withDerivedChanges(arr.map(p=>({date:String(p[0]||''),open:safeNum(p[1]),close:safeNum(p[2]),high:safeNum(p[3]),low:safeNum(p[4]),volume:safeNum(p[5]),amount:safeNum(p[6]),changePct:null,turnover:null})).filter(x=>x.date&&x.open!=null&&x.close!=null&&x.high!=null&&x.low!=null));
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
async function callAI(cfg,messages,timeout=30000){const endpoint=completionURL(cfg.ai_endpoint);const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+cfg.ai_api_key},body:JSON.stringify({model:cfg.ai_model,temperature:0.2,stream:false,messages}),signal:AbortSignal.timeout(timeout)});const raw=await r.text();if(!r.ok)throw Error('AI 服务返回 HTTP '+r.status+'（请求地址：'+endpoint+'）'+(raw?'：'+raw.slice(0,400):'；请检查 Endpoint 和模型权限'));let out;try{out=JSON.parse(raw)}catch{throw Error('AI 服务返回的不是有效 JSON：'+raw.slice(0,200))}const content=out.choices?.[0]?.message?.content;if(!content)throw Error('AI 响应中没有可用文本');return content}
async function quoteIndex(code){const headers={'user-agent':'Mozilla/5.0','referer':'https://quote.eastmoney.com/','accept':'application/json,text/plain,*/*'};const sec=(code==='000001'?'1.': '0.')+code;const u=new URL('https://push2.eastmoney.com/api/qt/stock/get');u.searchParams.set('secid',sec);u.searchParams.set('fields','f43,f44,f45,f46,f47,f48,f57,f58,f60');u.searchParams.set('ut','fa5fd1943c7b386f172d6893dbbd1d0c');const r=await fetch(u,{headers,signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('指数行情 HTTP '+r.status);const d=(await r.json())?.data;if(!d)throw Error('指数行情为空');const n=v=>v==null?null:Number(v)/100;return{code,name:d.f58||code,price:n(d.f43),open:n(d.f46),high:n(d.f44),low:n(d.f45),prevClose:n(d.f60),source:'eastmoney',fetchedAt:now()}}
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
 try{
  const u=new URL('https://push2.eastmoney.com/api/qt/clist/get');
  for(const [k,v] of Object.entries({pn:'1',pz:'100',po:'1',np:'1',fltt:'2',invt:'2',fid:'f62',fs:'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',fields:'f12,f14,f2,f3,f5,f6,f7,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f62,f115'}))u.searchParams.set(k,v);
  const r=await fetch(u,{headers,signal:AbortSignal.timeout(4500),cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
  const body=await r.json(),diff=body?.data?.diff;if(!Array.isArray(diff)||!diff.length)throw Error('返回空列表');
  const rows=diff.map(x=>({code:String(x.f12||''),name:String(x.f14||''),price:Number(x.f2),changePct:Number(x.f3),amount:Number(x.f6),turnover:Number(x.f8),pe:Number(x.f9),flow:x.f62==null||x.f62===''||x.f62==='-'?null:(Number.isFinite(Number(x.f62))?Number(x.f62):null),marketCap:Number(x.f20),rankSource:'eastmoney-money-flow'})).filter(x=>/^\d{6}$/.test(x.code)&&x.name&&!x.name.includes('ST')&&x.price>0);
  if(!rows.length)throw Error('返回数据无有效股票');return rows.slice(0,30);
 }catch(e){
  const primary=String(e?.message||e);
  // Independent fallback: Sina market center top-gainers list. It has no reliable capital-flow field, so flow remains null instead of being fabricated.
  const u=new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData');
  for(const [k,v] of Object.entries({page:'1',num:'100',sort:'changepercent',asc:'0',node:'hs_a',symbol:'',_:'1'}))u.searchParams.set(k,v);
  const r=await fetch(u,{headers:{...headers,'referer':'https://finance.sina.com.cn/'},signal:AbortSignal.timeout(5500),cache:'no-store'});
  if(!r.ok)throw Error('东方财富资金流排行失败（'+primary+'）；新浪涨幅榜 HTTP '+r.status);
  const raw=await r.text();let arr;try{arr=JSON.parse(raw)}catch{const m=raw.match(/\[[\s\S]*\]/);if(!m)throw Error('东方财富资金流排行失败（'+primary+'）；新浪涨幅榜格式异常');arr=JSON.parse(m[0])}
  if(!Array.isArray(arr)||!arr.length)throw Error('东方财富资金流排行失败（'+primary+'）；新浪涨幅榜为空');
  return arr.map(x=>({code:String(x.code||String(x.symbol||'').replace(/^(sh|sz)/,'')),name:String(x.name||''),price:Number(x.trade||x.price),changePct:Number(x.changepercent),amount:Number(x.amount),turnover:Number(x.turnoverratio),pe:null,flow:null,marketCap:null,rankSource:'sina-top-gainers',primaryError:primary})).filter(x=>/^\d{6}$/.test(x.code)&&x.name&&!x.name.includes('ST')&&x.price>0).slice(0,30);
 }
}
async function api(req,env){const u=new URL(req.url),p=u.pathname,db=env.DB;if(db)await init(db);if(p==='/api/health'){let ok=!!db;if(db)try{await db.prepare('SELECT 1').run()}catch{ok=false}return json({ok:ok,db:ok,version:'0.3.1',time:now()})}if(p==='/api/quote'){const c=u.searchParams.get('code');try{const q=await quote(c);if(q.source==='tencent'){await health(db,'tencent','ok','Actual quote source: Tencent',q.latencyMs)}else{await health(db,'tencent','error','Primary source failed: '+(q.primaryError||'unavailable'),q.latencyMs);await health(db,q.source,'ok','Actual quote source: '+q.source,q.latencyMs)}return json(q)}catch(e){await health(db,'eastmoney','error',e.message);return json({error:e.message},502)}}if(p==='/api/kline'){try{const k=await kline(u.searchParams.get('code'),+u.searchParams.get('limit')||120,u.searchParams.get('mode')||'day');if(k.source.includes('fallback')||k.source.startsWith('sina-intraday')){await health(db,'eastmoney-kline','error','Primary K-line source failed: '+(k.primaryError||'unavailable'),k.latencyMs);await health(db,k.source,'ok','Actual K-line source: '+k.source,k.latencyMs)}else{await health(db,k.source,'ok','Actual K-line source: '+k.source,k.latencyMs)}return json(k)}catch(e){await health(db,'eastmoney-kline','error',e.message);return json({error:e.message},502)}}if(p==='/api/analyze'){try{const a=await analyze(u.searchParams.get('code'));if(a.quote.source==='tencent'){await health(db,'tencent','ok','Actual quote source: Tencent',a.quote.latencyMs)}else{await health(db,'tencent','error','Primary quote source failed: '+(a.quote.primaryError||'unavailable'),a.quote.latencyMs);await health(db,a.quote.source,'ok','Actual quote source: '+a.quote.source,a.quote.latencyMs)}if(a.klineSource.includes('fallback')){await health(db,'eastmoney-kline','error','Primary K-line source failed: '+(a.klinePrimaryError||'unavailable'),a.klineLatencyMs);await health(db,'tencent-kline-fallback','ok','Actual K-line source: Tencent fallback',a.klineLatencyMs)}else{await health(db,'eastmoney-kline','ok','Actual K-line source: '+a.klineSource,a.klineLatencyMs)}return json(a)}catch(e){await health(db,'eastmoney','error',e.message);return json({error:e.message},502)}}if(p==='/api/trades'){const code=u.searchParams.get('code');let r;if(code)r=await db.prepare('SELECT * FROM trades WHERE code=? ORDER BY traded_at DESC,id DESC LIMIT 200').bind(code).run();else r=await db.prepare('SELECT * FROM trades ORDER BY traded_at DESC,id DESC LIMIT 200').run();return json(r.results||[])}if(p==='/api/holdings'){if(req.method==='GET')return json(await listHoldings(db));if(req.method==='POST')try{return json(await addTrade(db,await req.json()),201)}catch(e){return json({error:e.message},400)}}if(p==='/api/alerts'){const r=await db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100').run();return json(r.results||[])}if(p==='/api/data-health'){const r=await db.prepare('SELECT * FROM data_health').run();return json(r.results||[])}if(p==='/api/settings'&&req.method==='GET'){const r=await db.prepare("SELECT key,value FROM app_settings WHERE key IN ('ai_endpoint','ai_api_key','ai_model')").run();const cfg={};for(const x of r.results||[]){try{cfg[x.key]=JSON.parse(x.value)}catch{cfg[x.key]=x.value}}return json({endpoint:cfg.ai_endpoint||'https://api.openai.com/v1/chat/completions',model:cfg.ai_model||'',configured:!!(cfg.ai_endpoint&&cfg.ai_api_key&&cfg.ai_model),hasKey:!!cfg.ai_api_key})}if(p==='/api/settings'&&req.method==='POST'){const b=await req.json();const allowed=new Set(['ai_endpoint','ai_api_key','ai_model']);if(!allowed.has(b.key))return json({error:'不允许修改此配置项'},400);const value=String(b.value??'').trim();if(b.key==='ai_endpoint'){let z;try{z=new URL(value)}catch{return json({error:'Endpoint 必须是有效的 HTTPS URL'},400)}if(z.protocol!=='https:')return json({error:'Endpoint 必须使用 HTTPS'},400)}if(value.length>2000)return json({error:'配置值过长'},400);await db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(b.key,JSON.stringify(value),now()).run();return json({ok:true})}if(p==='/api/ai/analyze'&&req.method==='POST'){const b=await req.json().catch(()=>({}));const code=String(b.code||'').trim();const cfg=await getAIConfig(db);if(!cfg.ai_endpoint||!cfg.ai_api_key||!cfg.ai_model)return json({error:'请先在设置中配置 AI Endpoint、API Key 和 Model'},400);try{if(!/^\\d{6}$/.test(code))throw Error('股票代码应为6位数字');const q=await quote(code);const [k,news]=await Promise.all([kline(code,80,'day').then(v=>({data:v,error:null})).catch(e=>({data:null,error:String(e.message||e)})),fetchSinaMarketNews().then(v=>({data:v,error:null})).catch(e=>({data:[],error:String(e.message||e)}))]);const rows=k.data?.rows||[];const last=rows.at(-1),avg=n=>{const z=rows.slice(-n).map(x=>x.close).filter(Number.isFinite);return z.length?z.reduce((a,b)=>a+b,0)/z.length:null};const ma20=avg(20),ma60=avg(60);const a={quote:q,kline:rows.slice(-80),klineSource:k.data?.source||null,klineError:k.error,indicators:{ma5:avg(5),ma20,ma60,trend:last&&ma20!=null&&ma60!=null?(last.close>ma20&&ma20>=ma60?'偏强':last.close<ma20&&ma20<=ma60?'偏弱':'震荡'):'技术趋势数据不足'},dataWarning:k.error?'日K线暂不可用，本报告将基于可用行情生成，技术面结论受限。':undefined};const relatedNews=news.data.filter(x=>(x.title+' '+x.summary).includes(code)||(q.name&&(x.title+' '+x.summary).includes(q.name)));const content=await callAI(cfg,[{role:'system',content:'你是严谨的中国A股研究助手。只能依据输入数据分析，不得编造新闻、公告、资金流、财务指标或实时信息。新闻只能在明确相关时作为证据，引用标题和URL；若无个股相关新闻必须说明。明确区分事实、推断和缺失信息。输出简体中文，包含摘要、趋势与技术面、可验证资讯、风险、关键观察点、条件式操作计划。不得承诺收益。'},{role:'user',content:'分析股票 '+code+'。行情和日K数据：'+JSON.stringify({analysis:a,relatedNews:relatedNews,recentMarketNews:news.data.slice(0,8),newsFetchError:news.error,newsNote:relatedNews.length?'以下为标题/摘要匹配的相关新闻，仍需核验公告原文':'未找到标题/摘要明确提及该股票代码或名称的新闻，不得将泛财经新闻当作个股证据。'})}],55000);const created=now();await db.prepare('INSERT INTO reports(code,report_type,payload,created_at) VALUES(?,?,?,?)').bind(code,'ai_analysis',JSON.stringify({model:cfg.ai_model,content,generatedAt:created,source:a}),created).run();return json({ok:true,code,model:cfg.ai_model,generatedAt:created,content,ruleAnalysis:a})}catch(e){return json({error:String(e.message||e)},502)}}if(p==='/api/ai/screen'&&req.method==='POST'){const cfg=await getAIConfig(db);if(!cfg.ai_endpoint||!cfg.ai_api_key||!cfg.ai_model)return json({error:'请先在设置中配置 AI Endpoint、API Key 和 Model'},400);try{const [candidates,market,newsResult]=await Promise.all([fetchScreenCandidates(),Promise.all(['000001','399001','399006'].map(async code=>{try{return await quoteIndex(code)}catch(e){return{code,error:e.message}}})),fetchSinaMarketNews().then(items=>({items,error:null})).catch(e=>({items:[],error:String(e.message||e)}))]);// Keep external subrequests bounded: fallback-heavy quote/K-line chains can each call multiple providers.
const shortlist=candidates.slice(0,2);const settled=[];for(const c of shortlist){try{const q={source:'eastmoney-screen-rank',code:c.code,name:c.name,price:c.price,changePct:c.changePct,turnoverRate:c.turnover,pe:c.pe,amount:c.amount};settled.push({...c,ok:true,analysis:{quote:q,kline:[],klineSource:'not-fetched-for-time-budget',indicators:{ma5:null,ma20:null,ma60:null,trend:'技术趋势未拉取'},conclusion:{signal:'需进一步核验',risk:['本次选股为控制 Worker 请求耗时，未逐股拉取日K线']}}})}catch(e){settled.push({...c,ok:false,error:String(e.message||e)})}}const good=settled.filter(x=>x.ok).slice(0,2);if(!good.length)throw Error('候选股的行情或K线数据均获取失败');const content=await callAI(cfg,[{role:'system',content:'你是严谨的中国A股研究团队。必须只根据输入数据作判断，并区分数据事实、推断与缺失项。输入包括候选股行情/技术指标、可用时的资金流排行、市场指数及新浪财经近期资讯。资讯必须引用标题、发布时间和URL（如有），只能在标题/摘要与公司或行业确实相关时作为依据，不得把泛财经新闻硬套到个股；新浪涨幅榜回退时flow为null，禁止臆造资金流。输出：市场概况与数据时间；优先级排名；每只股的量价/趋势/资金流（未知则明说）、资讯支撑与关联理由、风险、待核验公告/财报、条件式分批计划与失效条件；指出追高风险。无个股相关新闻时明确说明，不能声称已完成公告核验；不承诺收益，不把排名当确定性买入指令。'},{role:'user',content:JSON.stringify({generatedAt:now(),marketIndices:market,newsSource:'Sina Finance public news feed',newsFetchError:newsResult.error,recentMarketNews:newsResult.items,flowRankedCandidates:good.map(x=>({rankData:{code:x.code,name:x.name,price:x.price,changePct:x.changePct,amount:x.amount,turnover:x.turnover,pe:x.pe,flow:x.flow,rankSource:x.rankSource,marketCap:x.marketCap},technicalAnalysis:x.analysis})),dataLimitations:['资讯为新浪财经市场资讯流，尚未完成逐股公告全文核验','板块整体资金流与行业轮动未全部接入','政策与外盘信息未全面接入','未拉取完整财报与估值历史']})}],22000);const created=now();await db.prepare('INSERT INTO reports(code,report_type,payload,created_at) VALUES(?,?,?,?)').bind(null,'ai_screen',JSON.stringify({model:cfg.ai_model,content,results:good,market,generatedAt:created}),created).run();return json({ok:true,model:cfg.ai_model,generatedAt:created,content,results:good,market})}catch(e){return json({error:String(e.message||e)},502)}}if(p==='/api/ai/holdings-report'&&req.method==='POST'){const cfg=await getAIConfig(db);if(!cfg.ai_endpoint||!cfg.ai_api_key||!cfg.ai_model)return json({error:'请先在设置中配置 AI Endpoint、API Key 和 Model'},400);try{const hs=await db.prepare('SELECT * FROM holdings WHERE shares>0 ORDER BY updated_at DESC').run();if(!hs.results?.length)return json({error:'当前没有有效持仓，先在个股页面录入买入交易'},400);const data=await Promise.all(hs.results.map(async h=>{let current;try{current=await analyze(h.code)}catch(e){current={error:String(e.message||e)}}const trades=await db.prepare('SELECT side,price,shares,fee,traded_at,note FROM trades WHERE code=? ORDER BY traded_at ASC,id ASC').bind(h.code).run();return{holding:h,marketAndTechnical:current,trades:trades.results||[]}}));const content=await callAI(cfg,[{role:'system',content:'你是严谨的中国A股持仓风险管理分析师。根据持仓数量、成本、完整交易流水和当前行情技术数据，输出组合总览、逐股优先级、浮动盈亏与风险、趋势情景预测（必须是条件情景而非确定预测）、继续持有/减仓/止损观察/分批加仓的条件式计划、关键价格观察区间和触发条件。没有足够数据的新闻/公告/板块资金/宏观消息必须列为缺失，不得编造。明确说明不构成确定性交易指令。'},{role:'user',content:JSON.stringify({generatedAt:now(),positions:data})}],45000);const created=now();await db.prepare('INSERT INTO reports(code,report_type,payload,created_at) VALUES(?,?,?,?)').bind(null,'holdings_report',JSON.stringify({model:cfg.ai_model,content,data,generatedAt:created}),created).run();return json({ok:true,model:cfg.ai_model,content,data,generatedAt:created})}catch(e){return json({error:String(e.message||e)},502)}}if(p==='/api/cron/morning')return json(await morning(db));return env.ASSETS.fetch(req)}
export default{async fetch(req,env){return new URL(req.url).pathname.startsWith('/api/')?api(req,env):env.ASSETS.fetch(req)},async scheduled(e,env,ctx){ctx.waitUntil(morning(env.DB))}}
