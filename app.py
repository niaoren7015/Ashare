import streamlit as st
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from openai import OpenAI
from datetime import datetime, timedelta
import uuid
import json
import extra_streamlit_components as stx

# ==================== 1. 页面基本配置 & 状态管理 ====================
st.set_page_config(page_title="A股智能投资管理与追踪分析工作流", page_icon="📈", layout="wide")
cookie_manager = stx.CookieManager()

if 'reports' not in st.session_state: st.session_state['reports'] = []
# 默认关注核心个股
if 'holdings' not in st.session_state: st.session_state['holdings'] = ["300131"] 

# 自动清理3天前的过期报告
now = datetime.now()
st.session_state['reports'] = [r for r in st.session_state['reports'] if now - r['created_at'] < timedelta(days=3)]

# ==================== 2. 全天候长假容灾版数据引擎 (DataEngine 3.0) ====================
class DataEngine:
    session = requests.Session()
    # 增加跨国网络重试容错率
    retries = Retry(total=3, backoff_factor=1.0, status_forcelist=[500, 502, 503, 504])
    session.mount('http://', HTTPAdapter(max_retries=retries))
    session.mount('https://', HTTPAdapter(max_retries=retries))
    
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://finance.sina.com.cn/"
    }
    
    # 适配代理节点延迟，全局超时调高至 10 秒
    REQ_TIMEOUT = 10 

    @staticmethod
    def _safe_float(val, default=0.0):
        if val in [None, '-', '', 'null']: return default
        try: return float(val)
        except: return default

    @classmethod
    def get_secid(cls, code: str) -> str:
        code = str(code).strip()
        return f"1.{code}" if code.startswith(('6', '688', '900')) else f"0.{code}"

    @classmethod
    def get_kline_data(cls, code: str, limit: int = 30):
        secid = cls.get_secid(code)
        url = f"http://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20500101&lmt={limit}"
        try:
            resp = cls.session.get(url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
            klines = resp.json().get('data', {}).get('klines', [])
            records = [{"日期": p.split(',')[0], "开盘": float(p.split(',')[1]), "收盘": float(p.split(',')[2]), "最高": float(p.split(',')[3]), "最低": float(p.split(',')[4])} for p in klines]
            return pd.DataFrame(records)
        except: return pd.DataFrame()

    @classmethod
    def get_market_overview(cls):
        url = "http://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.399006&fields=f2,f3,f14"
        try:
            resp = cls.session.get(url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
            data_block = resp.json().get('data')
            items = data_block.get('diff', []) if data_block else []
            if items:
                res = [f"{it.get('f14')}: {cls._safe_float(it.get('f2'))} ({cls._safe_float(it.get('f3'))}%)" for it in items]
                return " | ".join(res)
            
            # 长假兜底机制：实时接口失效时，提取历史 K 线最近一日数据
            res = []
            for code, name in [("000001", "上证指数"), ("399001", "深证成指"), ("399006", "创业板指")]:
                df = cls.get_kline_data(code, limit=2)
                if len(df) >= 2:
                    last_close = df.iloc[-1]['收盘']
                    prev_close = df.iloc[-2]['收盘']
                    change = round((last_close - prev_close) / prev_close * 100, 2)
                    res.append(f"{name} (历史): {last_close} ({change}%)")
            return " | ".join(res) if res else "大盘数据获取失败"
        except: return "大盘数据获取失败"

    @classmethod
    def get_macro_news(cls):
        url = "https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=5&page=1"
        try:
            resp = cls.session.get(url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
            items = resp.json().get('result', {}).get('data', [])
            return [f"• {it.get('title')}" for it in items if it.get('title')]
        except: return ["• 暂无最新宏观新闻。"]

    @classmethod
    def get_top_sectors_with_stocks(cls):
        url = "http://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&ut=b2884753fe08f51d4e9c22b760614ca7&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f2,f3,f62"
        try:
            resp = cls.session.get(url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
            data_block = resp.json().get('data')
            
            if not data_block:
                fallback_url = url.replace("fid=f62", "fid=f3")
                resp = cls.session.get(fallback_url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
                data_block = resp.json().get('data')
                
            if not data_block: return pd.DataFrame()
            
            sectors = data_block.get('diff', []) or []
            result = []
            for sec in sectors:
                sec_code, sec_name = sec.get('f12'), sec.get('f14')
                sec_change = cls._safe_float(sec.get('f3'))
                sec_inflow = cls._safe_float(sec.get('f62')) / 100000000.0
                
                s_url = f"http://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&ut=b2884753fe08f51d4e9c22b760614ca7&fltt=2&invt=2&fid=f62&fs=b:{sec_code}&fields=f12,f14,f2,f3,f62"
                s_resp = cls.session.get(s_url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
                s_data = s_resp.json().get('data')
                
                if not s_data:
                    s_fallback_url = s_url.replace("fid=f62", "fid=f3")
                    s_resp = cls.session.get(s_fallback_url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
                    s_data = s_resp.json().get('data')
                    
                stocks = s_data.get('diff', []) if s_data else []
                stock_list = [f"{st.get('f14')}({st.get('f12')}): 现价{cls._safe_float(st.get('f2'))}, 涨幅{cls._safe_float(st.get('f3'))}%" for st in stocks]
                
                result.append({
                    "板块名称": sec_name, "板块涨幅": f"{sec_change}%",
                    "主力净流入": f"{sec_inflow:.2f}亿" if sec_inflow != 0 else "休盘暂无", 
                    "龙头标的": " | ".join(stock_list)
                })
            return pd.DataFrame(result)
        except Exception: return pd.DataFrame()

    @classmethod
    def get_realtime_quote(cls, code: str):
        secid = cls.get_secid(code)
        url = f"http://push2.eastmoney.com/api/qt/ulist.np/get?secids={secid}&fields=f2,f3,f8,f12,f14,f47,f58,f62,f168"
        try:
            resp = cls.session.get(url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
            data_block = resp.json().get('data')
            items = data_block.get('diff', []) if data_block else []
            
            if items:
                data = items[0]
                return {
                    "code": code, "name": data.get('f14') or data.get('f58', '未知'),
                    "price": cls._safe_float(data.get('f2')), "change_pct": cls._safe_float(data.get('f3')),
                    "volume_hands": cls._safe_float(data.get('f47')), "turnover_rate": cls._safe_float(data.get('f8')) or cls._safe_float(data.get('f168')),
                    "main_inflow_wan": round(cls._safe_float(data.get('f62')) / 10000.0, 2),
                    "fetch_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
            
            df_k = cls.get_kline_data(code, limit=2)
            if len(df_k) >= 2:
                last_day = df_k.iloc[-1]
                prev_day = df_k.iloc[-2]
                change_pct = round((last_day['收盘'] - prev_day['收盘']) / prev_day['收盘'] * 100, 2)
                return {
                    "code": code, "name": f"{code}",
                    "price": last_day['收盘'], "change_pct": change_pct,
                    "volume_hands": 0.0, "turnover_rate": 0.0,
                    "main_inflow_wan": 0.0,
                    "fetch_time": f"{last_day['日期']} (长假静默期日线兜底)"
                }
            return None
        except Exception: return None

    @classmethod
    def get_stock_news(cls, code: str):
        url = f"https://search-api-web.eastmoney.com/search/jsonp?cb=&param=%7B%22keyword%22%3A%22{code}%22%2C%22type%22%3A%22cmsArticleWebOld%22%2C%22pageNum%22%3A1%2C%22pageSize%22%3A5%7D"
        try:
            resp = cls.session.get(url, headers=cls.HEADERS, timeout=cls.REQ_TIMEOUT)
            text = resp.text.strip()
            if text.startswith('('): text = text[1:-1]
            items = json.loads(text).get('result', {}).get('cmsArticleWebOld', [])
            res = [f"• [{it.get('date', '')[:10]}] {it.get('title', '')}" for it in items[:4]]
            return res if res else ["• 暂无个股近期重大新闻报道。"]
        except: return ["• 暂无个股近期重大新闻报道。"]

# ==================== 3. 侧边栏与模型配置 ====================
st.sidebar.header("⚙️ 模型与接口配置中心")
api_base = st.sidebar.text_input("API Base URL", value=cookie_manager.get(cookie="api_base") or "https://api.deepseek.com/v1")
api_key = st.sidebar.text_input("API Key", type="password", value=cookie_manager.get(cookie="api_key") or "")
model_name = st.sidebar.text_input("Model", value=cookie_manager.get(cookie="model_name") or "deepseek-chat")

if st.sidebar.button("💾 记住我的 API 配置"):
    cookie_manager.set("api_base", api_base); cookie_manager.set("api_key", api_key); cookie_manager.set("model_name", model_name)
    st.sidebar.success("配置已安全记录在本地浏览器中！")

st.sidebar.markdown("---")
st.sidebar.subheader("🧹 缓存数据管理")
if st.sidebar.button(f"清空缓存 (当前 {len(st.session_state['reports'])} 条)"):
    st.session_state['reports'] = []; st.rerun()

def call_llm(prompt: str) -> str:
    if not api_key: return "【系统提示】请先配置 API Key！"
    try:
        client = OpenAI(base_url=api_base, api_key=api_key)
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "你是一位顶级A股量化分析师。你必须【严格基于】用户提供的抓取数据进行分析研判，绝不允许凭空捏造数据！"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2
        )
        return response.choices[0].message.content
    except Exception as e: return f"API 错误: {str(e)}"

def save_report_card(tab, title, summary, full_content, raw_data_str):
    st.session_state['reports'].insert(0, {
        "id": str(uuid.uuid4()), "tab": tab, "title": title, "summary": summary,
        "full_content": full_content, "raw_data_str": raw_data_str,
        "created_at": datetime.now(), "time_str": datetime.now().strftime("%m-%d %H:%M")
    })

def render_history_cards(tab):
    cards = [r for r in st.session_state['reports'] if r['tab'] == tab]
    if not cards: return
    st.markdown(f"### 📑 已留存的分析报告列表")
    for c in cards:
        with st.container():
            st.markdown(f"#### 📌 {c['title']}  *(生成时间: {c['time_str']})*")
            st.info(f"**【核心概览提炼】**\n\n{c['summary']}")
            with st.expander("🔍 点击下拉查看完整全景深度报告与底层行情数据"):
                st.caption(f"**底层真实抓取参照数据:**\n\n{c['raw_data_str']}")
                st.markdown("---")
                st.markdown(c['full_content'])
            st.markdown("---")

# ==================== 4. 主 UI 界面逻辑 ====================
st.title("🐂 A股智能投资管理与追踪分析工作流")

tab1, tab2, tab3, tab4 = st.tabs(["🔥 1. 掘金选股与板块推荐", "🔍 2. 个股深度分析与搜索", "📋 3. 持仓股晨报预警", "⚖️ 4. 智能风控策略"])

with tab1:
    st.subheader("🤖 基于真实资金流向与宏观穿透掘金")
    if st.button("🚀 抓取【宏观->大盘->板块】数据并生成报告"):
        with st.spinner("正在直连拉取大盘指数、新浪宏观新闻及底层板块数据..."):
            macro_idx = DataEngine.get_market_overview()
            macro_news = "\n".join(DataEngine.get_macro_news())
            df_sectors = DataEngine.get_top_sectors_with_stocks()
            
            st.write(f"📊 **当前大盘:** `{macro_idx}`")
            
            # 【终极防崩解耦】即使板块接口完全下线，也不会阻断分析流程
            if df_sectors.empty:
                st.warning("🌴 监测到当前处于国庆长假/清算极冻期，东财板块排序接口已脱机。系统已自动切入【宏观研判兜底模式】。")
                sector_str = "长假休盘期，板块排序底层数据为空，请基于宏观新闻和历史大盘进行节后推演。"
            else:
                st.dataframe(df_sectors, use_container_width=True)
                sector_str = df_sectors.to_string(index=False)
            
            prompt = f"""
            【长假/实时硬核数据锚定】
            大盘历史/实时概况: {macro_idx}
            最新宏观新闻:
            {macro_news}
            
            当前板块及标的(若有):
            {sector_str}
            
            **严格遵守以下规则：**
            1. 结合以上宏观新闻与大盘，分析当前的政策情绪发酵情况及未来走向。
            2. 如果上述提供的板块数据为空（说明处于长假中），请直接结合宏观新闻，给出节后主要宽基/大科技方向的预判和复盘思路。
            3. 如果板块数据不为空，则优选板块中的 2 只标的进行重点推荐复盘。
            """
            
            with st.spinner("AI 大模型正在锚定硬核数据进行研判..."):
                res = call_llm(prompt)
                save_report_card("tab1", "A股宏观掘金与趋势研判报告", res[:150] + "...", res, f"大盘:{macro_idx}\n新闻:{macro_news}\n板块:\n{sector_str}")
                st.success("分析完成！已突破假期壁垒，基于可用数据生成。")
    render_history_cards("tab1")

with tab2:
    st.subheader("🔍 个股全景诊断 (支持节假日复盘)")
    col1, col2 = st.columns([2, 1])
    with col1: stock_input = st.text_input("输入 A 股代码", value="300131")
    with col2: add_to_hold = st.checkbox("分析后设为持仓股", value=True)
        
    if st.button("📊 抓取行情并诊断"):
        with st.spinner("安全抓取盘口与 24H 舆情..."):
            quote = DataEngine.get_realtime_quote(stock_input)
            news = "\n".join(DataEngine.get_stock_news(stock_input))
            
            if quote:
                st.write(f"📈 `{quote['name']} ({quote['code']})` | 收盘/现价: **¥{quote['price']}** | 涨跌: **{quote['change_pct']}%** | {quote['fetch_time']}")
                raw_context = f"股票:{quote['name']}({quote['code']})\n现价:¥{quote['price']} ({quote['change_pct']}%)\n舆情:\n{news}"
                prompt = f"请严格基于以下抓取到的真实数据对 {quote['name']}({quote['code']}) 进行诊断：\n{raw_context}\n给出综合诊断和明确操作建议。"
                
                res = call_llm(prompt)
                save_report_card("tab2", f"{quote['name']}({quote['code']}) 全景诊断报告", res[:120] + "...", res, raw_context)
                if add_to_hold and stock_input not in st.session_state['holdings']: st.session_state['holdings'].append(stock_input)
            else: st.error("未能抓取到有效行情，请检查网络或代码。")
    render_history_cards("tab2")

with tab3:
    st.subheader("📋 自动巡检早盘/休市预警")
    current_holdings = st.multiselect("当前持仓：", list(set(st.session_state['holdings'] + ["300131"])), default=st.session_state['holdings'])
    st.session_state['holdings'] = current_holdings
    
    if st.button("⏰ 触发 24H 舆情与资金面扫描"):
        with st.spinner("巡检持仓股真实盘口与舆情中..."):
            all_context = []
            for code in current_holdings:
                q = DataEngine.get_realtime_quote(code)
                n = "\n".join(DataEngine.get_stock_news(code))
                if q: all_context.append(f"【{q['name']}({code})】现价/收盘:¥{q['price']} ({q['change_pct']}%)\n舆情:{n}")
            
            combined_str = "\n\n".join(all_context)
            prompt = f"针对以下持仓股的真实盘面与舆情数据：\n{combined_str}\n请生成持仓股预警报告，剖析异动、发酵消息与长假/早盘应对策略。"
            res = call_llm(prompt)
            save_report_card("tab3", f"持仓巡检预警 ({len(current_holdings)}支)", res[:120] + "...", res, combined_str)
    render_history_cards("tab3")

with tab4:
    st.subheader("⚖️ 风控与仓位策略")
    if not st.session_state['holdings']: st.info("请先添加持仓股。")
    else:
        select_stock = st.selectbox("选择风控标的", st.session_state['holdings'], index=st.session_state['holdings'].index("300131") if "300131" in st.session_state['holdings'] else 0)
        col_a, col_b = st.columns(2)
        with col_a: cost_price = st.number_input("持仓成本价 (元)", value=6.5, step=0.1)
        with col_b: volume = st.number_input("持仓数量 (股)", value=30000, step=1000)
        
        q_data = DataEngine.get_realtime_quote(select_stock)
        curr_price = q_data['price'] if q_data and q_data['price'] != 0 else cost_price
        profit_rate = round(((curr_price - cost_price) / cost_price) * 100, 2) if cost_price > 0 else 0
        
        st.write(f"📈 `{select_stock}` | 最新价: `¥{curr_price}` | 成本: `¥{cost_price}` | 浮动盈亏: **{profit_rate}%**")
        
        if st.button("🛡️ 生成动态仓位策略"):
            prompt = f"持仓:{select_stock}, 当前价:¥{curr_price}, 成本:¥{cost_price}, 股数:{volume}股, 盈亏比:{profit_rate}%。\n请基于不恐慌割肉、留底仓跟随趋势的原则，结合当前盈亏状态，给出具体的量化减仓/止盈/补仓计算建议。"
            res = call_llm(prompt)
            save_report_card("tab4", f"{select_stock} 仓位策略 (盈亏: {profit_rate}%)", res[:120] + "...", res, f"价:{curr_price}, 本:{cost_price}, 量:{volume}, 盈亏:{profit_rate}%")
    render_history_cards("tab4")
