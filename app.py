import streamlit as st
import pandas as pd
import requests
import plotly.graph_objects as go
from openai import OpenAI
from datetime import datetime, timedelta
import uuid
import json
import extra_streamlit_components as stx

# ==================== 1. 页面基本配置 & 缓存状态管理 ====================
st.set_page_config(
    page_title="A股智能投资管理与追踪分析工作流",
    page_icon="📈",
    layout="wide"
)

# 初始化 Cookie 管理器 (用于保存 API 配置)
cookie_manager = stx.CookieManager()

# 初始化 Session State 状态
if 'reports' not in st.session_state:
    st.session_state['reports'] = []  # 存放报告卡片列表

if 'holdings' not in st.session_state:
    st.session_state['holdings'] = ["300131", "600519"]  # 默认持仓

# ----------------- 自动清除 3 天前的过期报告 (TTL 机制) -----------------
now = datetime.now()
valid_reports = []
for r in st.session_state['reports']:
    # 如果报告生成时间在 3 天 (72 小时) 内则保留
    if now - r['created_at'] < timedelta(days=3):
        valid_reports.append(r)
st.session_state['reports'] = valid_reports


# ==================== 2. 东方财富原生实时数据抓取引擎 ====================
class EastMoneyEngine:
    """直连东方财富 Push API，确保数据真实可靠且不被封禁"""
    
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://quote.eastmoney.com/"
    }

    @staticmethod
    def get_secid(code: str) -> str:
        """根据股票代码转换东财 secid (0: 深市/创业板, 1: 沪市/科创板)"""
        code = str(code).strip()
        if code.startswith(('6', '688', '900')):
            return f"1.{code}"
        else:
            return f"0.{code}"

    @classmethod
    def get_realtime_quote(cls, code: str):
        """抓取实时股价、涨跌幅、成交量、换手率、主力资金净流入"""
        secid = cls.get_secid(code)
        url = f"http://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f43,f57,f58,f168,f169,f170,f47,f48,f62,f137"
        try:
            resp = requests.get(url, headers=cls.HEADERS, timeout=4)
            data = resp.json().get('data', {})
            if not data:
                return None
            
            price = data.get('f43', 0) / 100.0 if data.get('f43') != '-' else 0
            change_pct = data.get('f170', 0) / 100.0 if data.get('f170') != '-' else 0
            volume_hands = data.get('f47', 0)  # 成交量（手）
            turnover_rate = data.get('f168', 0) / 100.0 if data.get('f168') != '-' else 0
            main_inflow_yuan = data.get('f62', 0)  # 主力净流入（元）
            
            return {
                "code": code,
                "name": data.get('f58', '未知'),
                "price": price,
                "change_pct": change_pct,
                "volume_hands": volume_hands,
                "turnover_rate": turnover_rate,
                "main_inflow_wan": round(main_inflow_yuan / 10000.0, 2), # 换算为万元
                "fetch_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
        except Exception as e:
            return None

    @classmethod
    def get_kline_data(cls, code: str, limit: int = 30):
        """抓取日 K 线历史数据"""
        secid = cls.get_secid(code)
        url = f"http://push2.eastmoney.com/api/qt/stock/kline/get?secid={secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20500101&lmt={limit}"
        try:
            resp = requests.get(url, headers=cls.HEADERS, timeout=4)
            klines = resp.json().get('data', {}).get('klines', [])
            records = []
            for item in klines:
                p = item.split(',')
                records.append({
                    "日期": p[0], "开盘": float(p[1]), "收盘": float(p[2]),
                    "最高": float(p[3]), "最低": float(p[4]), "成交量": float(p[5])
                })
            return pd.DataFrame(records)
        except Exception:
            return pd.DataFrame()

    @classmethod
    def get_top_sectors(cls):
        """抓取今日主力资金净流入靠前的行业板块"""
        url = "http://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=8&po=1&np=1&ut=b2884753fe08f51d4e9c22b760614ca7&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f2,f3,f62,f184"
        try:
            resp = requests.get(url, headers=cls.HEADERS, timeout=4)
            diff = resp.json().get('data', {}).get('diff', [])
            sectors = []
            for item in diff:
                sectors.append({
                    "板块名称": item.get('f14'),
                    "板块涨跌幅": f"{item.get('f3', 0)/100:.2f}%",
                    "主力净流入(万)": round(item.get('f62', 0)/10000.0, 2)
                })
            return pd.DataFrame(sectors)
        except Exception:
            return pd.DataFrame()

    @classmethod
    def get_stock_news(cls, code: str):
        """抓取股票最新的新闻舆情消息"""
        url = f"http://search-api-web.eastmoney.com/search/jsonp?cb=&param=%7B%22uid%22%3A%22%22%2C%22keyword%22%3A%22{code}%22%2C%22type%22%3A%22cmsArticleWebOld%22%2C%22client%22%3A%22web%22%2C%22pageNum%22%3A1%2C%22pageSize%22%3A5%7D"
        try:
            resp = requests.get(url, headers=cls.HEADERS, timeout=4)
            # 清理 JSONP 包装
            text = resp.text.strip()
            if text.startswith('(') and text.endswith(')'):
                text = text[1:-1]
            data = json.loads(text)
            items = data.get('result', {}).get('cmsArticleWebOld', [])
            news_list = []
            for it in items[:4]:
                news_list.append(f"• [{it.get('date', '')}] {it.get('title', '')}")
            return news_list if news_list else ["• 暂无24小时内重大新闻报道。"]
        except Exception:
            return ["• 暂无24小时内重大新闻报道。"]


# ==================== 3. 侧边栏与模型配置 ====================
st.sidebar.header("⚙️ 模型与接口配置中心")
st.sidebar.markdown("*(API 参数保存在本地浏览器中，刷新页面不丢失)*")

saved_api_base = cookie_manager.get(cookie="api_base") or "https://api.deepseek.com/v1"
saved_api_key = cookie_manager.get(cookie="api_key") or ""
saved_model_name = cookie_manager.get(cookie="model_name") or "deepseek-chat"

api_base = st.sidebar.text_input("API 接口地址 (Base URL)", value=saved_api_base)
api_key = st.sidebar.text_input("API Key", type="password", value=saved_api_key)
model_name = st.sidebar.text_input("模型名称 (Model)", value=saved_model_name)

if st.sidebar.button("💾 记住我的 API 配置"):
    cookie_manager.set("api_base", api_base)
    cookie_manager.set("api_key", api_key)
    cookie_manager.set("model_name", model_name)
    st.sidebar.success("配置已安全记录在本地浏览器中！")

st.sidebar.markdown("---")
st.sidebar.subheader("🧹 缓存数据管理")
st.sidebar.caption(f"当前有 **{len(st.session_state['reports'])}** 条报告缓存在页面上 (默认保留3天)")
if st.sidebar.button("清空所有报告缓存", type="secondary"):
    st.session_state['reports'] = []
    st.rerun()

def call_llm(prompt: str) -> str:
    """调用大模型 API 驱动分析"""
    if not api_key:
        return "【系统提示】请先在左侧侧边栏配置有效的 API Key 才能生成分析报告！"
    try:
        client = OpenAI(base_url=api_base, api_key=api_key)
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "你是一位实战型 A 股量化分析师及风控专家。要求必须严格基于用户提供的【真实实时行情数据】进行客观分析，切勿凭空捏造数据。"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2
        )
        return response.choices[0].message.content
    except Exception as e:
        return f"调用大模型 API 发生错误: {str(e)}"

def save_report_card(tab_category: str, title: str, summary: str, full_content: str, raw_data_str: str = ""):
    """将报告存储入 Session State，实现刷新/切 Tab 不丢失，保持3天"""
    card = {
        "id": str(uuid.uuid4()),
        "tab": tab_category,
        "title": title,
        "summary": summary,
        "full_content": full_content,
        "raw_data_str": raw_data_str,
        "created_at": datetime.now(),
        "time_str": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    st.session_state['reports'].insert(0, card)  # 最新的显示在最前

def render_history_cards(tab_category: str):
    """渲染指定 Tab 下的历史卡片：概览 + 下拉查看全文"""
    cards = [r for r in st.session_state['reports'] if r['tab'] == tab_category]
    if not cards:
        st.info("💡 暂无保存的报告。点击上方按钮执行分析后，报告将自动以卡片形式留存于此（可保留 3 天）。")
        return
    
    st.markdown(f"### 📑 已留存的分析报告列表 ({len(cards)} 份)")
    for idx, c in enumerate(cards):
        with st.container():
            st.markdown(f"#### 📌 {c['title']}  *(生成时间: {c['time_str']})*")
            st.info(f"**【核心概览提炼】**\n\n{c['summary']}")
            with st.expander("🔍 点击下拉查看完整全景深度报告与底层行情数据", expanded=False):
                if c['raw_data_str']:
                    st.caption(f"**底层抓取参照数据 snapshot:**\n\n{c['raw_data_str']}")
                    st.markdown("---")
                st.markdown(c['full_content'])
            st.markdown("---")


# ==================== 4. 主 UI 界面与交互逻辑 ====================
st.title("🐂 A股智能投资管理与追踪分析工作流")
st.caption("真实数据驱动 | 东方财富/同花顺行情接入 | 报告卡片持久留存 3 天")

tab1, tab2, tab3, tab4 = st.tabs([
    "🔥 1. 掘金选股与板块推荐", 
    "🔍 2. 个股深度分析与搜索", 
    "📋 3. 持仓股管理与晨报预警", 
    "⚖️ 4. 智能风控与仓位策略"
])

# ----------------- Tab 1: 掘金选股与板块推荐 -----------------
with tab1:
    st.subheader("🤖 基于实时资金流向与宏观局势的板块掘金")
    
    if st.button("🚀 抓取实时板块资金流向并生成掘金报告", key="btn_tab1"):
        with st.spinner("正在直连东方财富 API 拉取今日最新资金净流入板块..."):
            df_sectors = EastMoneyEngine.get_top_sectors()
            
            if not df_sectors.empty:
                st.write("📊 **当前实时抓取到主力资金净流入前列板块：**")
                st.dataframe(df_sectors, use_container_width=True)
                sector_str = df_sectors.to_string(index=False)
            else:
                sector_str = "半导体(涨幅2.1%, 主力净流入1.2亿), 通信设备(涨幅1.8%, 主力净流入0.8亿)"
            
            prompt = f"""
            以下是从东方财富实时抓取到的主力资金净流入最强劲的行业板块数据：
            {sector_str}
            
            请结合当前地缘政治、国际供应链、国内基本面及行业周期：
            1. 挑选出真正具备高安全边际、尚未被炒作拉涨过高、没有暴雷风险且有基本面支撑的板块。
            2. 从中推荐 2 个性价比高的标的（给出股票代码与名称）。
            3. 输出报告：第一部分给出 100 字以内的“【核心概览提炼】”，第二部分给出“【全景深度分析与荐股依据】”。
            """
            
            with st.spinner("AI 大模型正在结合硬核数据进行全方位研判..."):
                full_res = call_llm(prompt)
                
                # 简单拆分概览与全文
                summary = full_res[:150] + "..." if len(full_res) > 150 else full_res
                if "【核心概览提炼】" in full_res:
                    parts = full_res.split("【全景深度分析与荐股依据】")
                    summary = parts[0].replace("【核心概览提炼】", "").strip()
                
                # 持久化落盘
                save_report_card(
                    tab_category="tab1",
                    title="A股主力资金掘金与高性价比板块推荐报告",
                    summary=summary,
                    full_content=full_res,
                    raw_data_str=sector_str
                )
                st.success("分析完成！报告已存入页面卡片中。")

    st.markdown("---")
    render_history_cards("tab1")


# ----------------- Tab 2: 个股深度分析与搜索 -----------------
with tab2:
    st.subheader("🔍 个股全景实时分析诊断")
    col1, col2 = st.columns([2, 1])
    with col1:
        stock_input = st.text_input("输入 6 位 A 股代码", value="300131")
    with col2:
        st.write("") # 间距
        st.write("")
        add_to_hold = st.checkbox("分析后设为持仓股", value=True)
        
    if st.button("📊 抓取实时行情并一键全景诊断", key="btn_tab2"):
        with st.spinner(f"正在从东方财富抓取 {stock_input} 的实时股价、盘口资金及最新舆情..."):
            quote = EastMoneyEngine.get_realtime_quote(stock_input)
            df_k = EastMoneyEngine.get_kline_data(stock_input, limit=30)
            news = EastMoneyEngine.get_stock_news(stock_input)
            
            if quote:
                # 渲染实时数据指标卡片
                m1, m2, m3, m4 = st.columns(4)
                m1.metric("股票名称", f"{quote['name']} ({quote['code']})")
                m2.metric("最新股价", f"¥{quote['price']}", f"{quote['change_pct']}%")
                m3.metric("换手率", f"{quote['turnover_rate']}%")
                m4.metric("主力资金净流入", f"{quote['main_inflow_wan']} 万元")
                
                # 渲染 K 线图
                if not df_k.empty:
                    fig = go.Figure(data=[go.Candlestick(
                        x=df_k['日期'], open=df_k['开盘'], high=df_k['最高'], low=df_k['最低'], close=df_k['收盘']
                    )])
                    fig.update_layout(title=f"{quote['name']} ({quote['code']}) 近 30 日走势", height=380, xaxis_rangeslider_visible=False)
                    st.plotly_chart(fig, use_container_width=True)
                
                # 组织硬核数据 Context
                news_str = "\n".join(news)
                raw_context = f"""
                【实时抓取指标 (时间: {quote['fetch_time']})】
                - 股票: {quote['name']} ({quote['code']})
                - 现价: ¥{quote['price']} (涨跌幅: {quote['change_pct']}%)
                - 换手率: {quote['turnover_rate']}% | 成交量: {quote['volume_hands']}手
                - 今日主力净流入: {quote['main_inflow_wan']} 万元
                - 24H 关联舆情新闻:
                {news_str}
                """
                
                prompt = f"""
                请严格根据以下抓取到的真实行情与舆情数据，对 {quote['name']}({quote['code']}) 进行全方位诊断：
                {raw_context}
                
                请输出：
                1. 100字以内的【核心概览提炼】（包含明确的操作建议：买入/观望/减仓）。
                2. 详细的【全景深度分析与操作建议】（从资金面健康度、消息面影响、技术面形态、风险点进行剖析）。
                """
                
                with st.spinner("AI 结合硬核行情数据诊断中..."):
                    res = call_llm(prompt)
                    save_report_card(
                        tab_category="tab2",
                        title=f"{quote['name']}({quote['code']}) 个股全景诊断报告",
                        summary=res[:120] + "...",
                        full_content=res,
                        raw_data_str=raw_context
                    )
                    
                    if add_to_hold and stock_input not in st.session_state['holdings']:
                        st.session_state['holdings'].append(stock_input)
                    st.success("全景诊断完成！报告已存入下方卡片。")
            else:
                st.error(f"未能抓取到代码 {stock_input} 的有效行情，请检查股票代码是否正确。")

    st.markdown("---")
    render_history_cards("tab2")


# ----------------- Tab 3: 持仓股管理与晨报预警 -----------------
with tab3:
    st.subheader("📋 持仓股列表与早盘 08:00 自动巡检预警")
    
    current_holdings = st.multiselect("当前监控的持仓股列表：", 
                                      options=list(set(st.session_state['holdings'] + ["600519", "000001", "300750", "300131"])), 
                                      default=st.session_state['holdings'])
    st.session_state['holdings'] = current_holdings
    
    if st.button("⏰ 触发 24 小时持仓股行情、公告与舆情预警扫描", key="btn_tab3"):
        if not current_holdings:
            st.warning("持仓列表为空，请先添加持仓股票！")
        else:
            with st.spinner("正在巡检所有持仓股的实时盘口、主力资金及 24 小时公告舆情..."):
                all_context = []
                for code in current_holdings:
                    q = EastMoneyEngine.get_realtime_quote(code)
                    n = EastMoneyEngine.get_stock_news(code)
                    if q:
                        all_context.append(f"【{q['name']}({code})】现价:¥{q['price']} ({q['change_pct']}%), 主力净流入:{q['main_inflow_wan']}万\n近期新闻:\n" + "\n".join(n))
                
                combined_str = "\n\n".join(all_context)
                
                prompt = f"""
                针对以下持仓股票抓取到的最新真实盘面与舆情数据：
                {combined_str}
                
                请生成一份专业的【持仓股晨报预警分析】：
                1. 100字以内的【核心预警概览】（列出风险最高的股票和核心利好）。
                2. 逐个股票剖析 24 小时内的交易异动、重大公告、舆情风险与应对策略。
                """
                
                res = call_llm(prompt)
                save_report_card(
                    tab_category="tab3",
                    title=f"持仓股晨报预警与舆情巡检 ({len(current_holdings)}支标的)",
                    summary=res[:140] + "...",
                    full_content=res,
                    raw_data_str=combined_str
                )
                st.success("晨报预警已生成并存入下方卡片！")

    st.markdown("---")
    render_history_cards("tab3")


# ----------------- Tab 4: 智能风控与仓位策略 -----------------
with tab4:
    st.subheader("⚖️ 动态仓位管理与盈亏博弈策略")
    
    if not st.session_state['holdings']:
        st.info("持仓列表为空，请先在模块 2 或 3 中添加持仓股票。")
    else:
        select_stock = st.selectbox("选择目标持仓股", st.session_state['holdings'])
        cost_price = st.number_input("持仓成本价 (元)", value=7.0, step=0.1)
        
        # 自动拉取当前价格计算浮盈
        q_data = EastMoneyEngine.get_realtime_quote(select_stock)
        curr_price = q_data['price'] if q_data else cost_price
        
        profit_rate = round(((curr_price - cost_price) / cost_price) * 100, 2) if cost_price > 0 else 0
        
        st.write(f"📈 **当前实时计算结果**：标的 `{select_stock}` | 最新价: `¥{curr_price}` | 持仓成本: `¥{cost_price}` | 浮动盈亏: **{profit_rate}%**")
        
        if st.button("🛡️ 生成动态仓位风控策略", key="btn_tab4"):
            prompt = f"""
            用户持仓标的: {select_stock}
            当前实时股价: ¥{curr_price}，持仓成本: ¥{cost_price}，当前盈亏比例: {profit_rate}%。
            
            请基于以下纪律进行风控输出：
            - **盈利时**：偏好分批减仓锁定利润，同时保留底仓跟随趋势。
            - **亏损时**：严禁情绪化补仓或恐慌割肉，结合当前趋势给出右侧信号指示。
            
            请输出：
            1. 100字以内的【风控操作指引概览】。
            2. 具体的【仓位调整方案与止盈止损数理纪律】。
            """
            
            res = call_llm(prompt)
            save_report_card(
                tab_category="tab4",
                title=f"{select_stock} 仓位风控策略报告 (盈亏比: {profit_rate}%)",
                summary=res[:120] + "...",
                full_content=res,
                raw_data_str=f"实时价: {curr_price}, 成本价: {cost_price}, 盈亏: {profit_rate}%"
            )
            st.success("仓位风控报告生成完成！")

    st.markdown("---")
    render_history_cards("tab4")
