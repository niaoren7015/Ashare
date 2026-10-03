import streamlit as st
import pandas as pd
import requests
import json
import os
import time
from datetime import datetime
from openai import OpenAI

# ==================== 1. 页面配置与全局样式 ====================
st.set_page_config(
    page_title="A股智能量化与追踪分析工作流",
    page_icon="📈",
    layout="wide"
)

CACHE_FILE = "reports_cache.json"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# ==================== 2. 本地 3 天持久化缓存引擎 ====================
def load_reports_cache():
    """读取本地报告缓存，自动清空超过 3 天的过期报告"""
    if not os.path.exists(CACHE_FILE):
        return []
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            now = time.time()
            # 过滤留存 3 天 (3 * 86400 秒) 内的报告
            valid_data = [item for item in data if now - item.get("timestamp", 0) <= 3 * 86400]
            return valid_data
    except Exception:
        return []

def save_report_to_cache(tab_name, title, summary, full_content, stock_code=""):
    """保存新生成的分析报告到本地文件"""
    reports = load_reports_cache()
    new_report = {
        "id": str(int(time.time() * 1000)),
        "timestamp": time.time(),
        "time_str": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "tab": tab_name,
        "title": title,
        "summary": summary,
        "content": full_content,
        "stock_code": stock_code
    }
    reports.insert(0, new_report)  # 最新产生的排在最前
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(reports, f, ensure_ascii=False, indent=2)

def clear_all_cache():
    """一键清空所有历史报告缓存"""
    if os.path.exists(CACHE_FILE):
        os.remove(CACHE_FILE)

# 初始化 Session State
if 'holdings' not in st.session_state:
    st.session_state['holdings'] = ["600519", "300131"]

# ==================== 3. 实时数据抓取引擎（东方财富/腾讯/新浪 REST API） ====================
class RealTimeADataFetcher:
    
    @staticmethod
    def get_stock_spot(stock_code):
        """获取单只个股实时行情与主力资金指标"""
        code = str(stock_code).strip().zfill(6)
        prefix = "sh" if code.startswith("6") or code.startswith("9") or code.startswith("688") else "sz"
        secid = f"1.{code}" if prefix == "sh" else f"0.{code}"
        
        spot_data = {
            "code": code, "name": "未知股票", "price": 0.0, "change_pct": 0.0,
            "turnover_rate": 0.0, "pe_ttm": 0.0, "amount_ten_thousand": 0.0,
            "main_net_inflow_yi": 0.0, "fetch_time": datetime.now().strftime("%H:%M:%S")
        }
        
        # 1.1 抓取实时股价与成交量 (腾讯接口)
        try:
            url_tx = f"http://qt.gtimg.cn/q={prefix}{code}"
            r = requests.get(url_tx, headers=HEADERS, timeout=3)
            if r.status_code == 200 and "=" in r.text:
                parts = r.text.split("=")[1].strip('"').split("~")
                if len(parts) > 39:
                    spot_data["name"] = parts[1]
                    spot_data["price"] = float(parts[3]) if parts[3] else 0.0
                    spot_data["change_pct"] = float(parts[32]) if parts[32] else 0.0
                    spot_data["amount_ten_thousand"] = round(float(parts[37]), 2) if parts[37] else 0.0
                    spot_data["turnover_rate"] = float(parts[38]) if parts[38] else 0.0
                    spot_data["pe_ttm"] = float(parts[39]) if parts[39] else 0.0
        except Exception:
            pass

        # 1.2 抓取主力资金净流入 (东方财富 REST API)
        try:
            url_em = f"https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f62"
            r_em = requests.get(url_em, headers=HEADERS, timeout=3)
            if r_em.status_code == 200:
                j = r_em.json()
                if j.get("data") and j["data"].get("f62") is not None:
                    spot_data["main_net_inflow_yi"] = round(j["data"]["f62"] / 100000000.0, 2)
        except Exception:
            pass

        return spot_data

    @staticmethod
    def get_top_sectors():
        """抓取今日主力资金净流入排名前 10 的行业板块"""
        url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fields=f12,f14,f2,f3,f62,f184&fid=f62&fs=m:90+t:2"
        try:
            r = requests.get(url, headers=HEADERS, timeout=3)
            if r.status_code == 200:
                diff = r.json().get("data", {}).get("diff", [])
                sectors = []
                for item in diff:
                    sectors.append({
                        "板块代码": item.get("f12"),
                        "板块名称": item.get("f14"),
                        "涨跌幅(%)": item.get("f3"),
                        "主力净流入(亿元)": round(item.get("f62", 0) / 100000000.0, 2),
                        "主力净占比(%)": item.get("f184", 0)
                    })
                return pd.DataFrame(sectors)
        except Exception:
            pass
        return pd.DataFrame()

    @staticmethod
    def get_realtime_news():
        """抓取东方财富 24 小时实时财联社电报/快讯"""
        url = "https://fastnewsapi.eastmoney.com/News/RealTimeNewsList?pageIndex=1&pageSize=8"
        news_list = []
        try:
            r = requests.get(url, headers=HEADERS, timeout=3)
            if r.status_code == 200:
                items = r.json().get("data", [])
                for item in items:
                    news_list.append({
                        "time": item.get("showtime", ""),
                        "title": item.get("title", ""),
                        "digest": item.get("digest", "")
                    })
        except Exception:
            pass
        return news_list

# ==================== 4. 侧边栏配置与缓存清理 ====================
st.sidebar.header("⚙️ 系统与 API 配置中心")

api_base = st.sidebar.text_input("API 接口地址 (Base URL)", value="https://api.deepseek.com/v1")
api_key = st.sidebar.text_input("API Key", type="password", value="")
model_name = st.sidebar.text_input("模型名称 (Model)", value="deepseek-chat")

st.sidebar.markdown("---")
st.sidebar.header("📂 本地数据缓存")
if st.sidebar.button("🗑️ 清除所有历史报告缓存", type="secondary"):
    clear_all_cache()
    st.sidebar.success("✅ 已一键清空所有历史报告缓存！")
    st.rerun()

def call_llm(prompt_content):
    """通用 LLM 调用接口"""
    if not api_key:
        return "【系统提示】请先在左侧侧边栏配置有效的 API Key 才能启用 AI 深度分析报告功能！"
    try:
        client = OpenAI(base_url=api_base, api_key=api_key)
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "你是一位精通A股量化实盘、资金面与宏观研判的首席策略分析师。要求输出内容严密结合给出的真实实时数据与快讯，禁止泛泛而谈的废话，给出落地可行性高的操作建议。"},
                {"role": "user", "content": prompt_content}
            ],
            temperature=0.2
        )
        return response.choices[0].message.content
    except Exception as e:
        return f"调用大模型 API 发生错误: {str(e)}"

def render_history_cards(tab_name):
    """渲染指定 Tab 的历史保留卡片 (默认保留3天)"""
    reports = load_reports_cache()
    tab_reports = [r for r in reports if r.get("tab") == tab_name]
    
    st.markdown("---")
    st.markdown(f"### 📚 {tab_name} - 历史报告面板 *(展示3天内记录，无需重复消耗 Token)*")
    if not tab_reports:
        st.info("暂无该模块的历史报告记录。请点击上方按钮进行实时生成。")
        return

    for item in tab_reports:
        with st.expander(f"⏱️ [{item['time_str']}] {item['title']}"):
            st.markdown(f"**📌 摘要概览：** {item['summary']}")
            st.markdown("---")
            st.markdown(item['content'])

# ==================== 5. 主界面导航与业务 Tab ====================
st.title("🐂 A股智能量化投资管理与追踪分析工作流")
st.caption("真实数据基准硬约束（东财/腾讯/新浪 REST API 直连） + 3 天本地报告卡片保留引擎")

tab1, tab2, tab3, tab4 = st.tabs([
    "🔥 1. 掘金选股与板块推荐", 
    "🔍 2. 个股深度分析与搜索", 
    "📋 3. 持仓股管理与晨报预警", 
    "⚖️ 4. 智能风控与仓位策略"
])

# -------------------- Tab 1: 掘金选股与板块推荐 --------------------
with tab1:
    st.subheader("🤖 板块资金面挖掘与实时荐股")
    
    if st.button("🚀 实时抓取东财/新浪资金流与快讯并生成报告", type="primary"):
        with st.spinner("正在从东方财富/新浪抓取实时行业资金流向及 24h 快讯..."):
            df_sectors = RealTimeADataFetcher.get_top_sectors()
            news_list = RealTimeADataFetcher.get_realtime_news()
            
            st.markdown("#### 📊 实时数据硬基准（东方财富主力资金 TOP 10 板块）")
            if not df_sectors.empty:
                st.dataframe(df_sectors, use_container_width=True)
            else:
                st.warning("⚠️ 实时板块资金流向数据抓取超时，将基于快讯数据进行研判。")

            prompt = f"""
            以下是东方财富实时抓取的主力资金净流入 TOP 10 行业板块数据：
            {df_sectors.to_string() if not df_sectors.empty else '数据暂时不可用'}

            以下是最新 24 小时市场快讯电报：
            {json.dumps(news_list, ensure_ascii=False, indent=2)}

            请结合以上【真实实时数据与最新快讯】：
            1. 全方位评估哪些板块具备高安全边际、尚未被炒作且有资金面硬支撑。
            2. 挑选 2-3 个具备较高性价比的标的（给出股票名称与代码）。
            3. 输出“板块与荐股分析报告”，明确指出基本面支撑点与避雷提示。
            """
            
            full_report = call_llm(prompt)
            st.markdown("### 💡 深度荐股报告与分析")
            st.markdown(full_report)
            
            # 生成概览并存入本地缓存
            summary = full_report[:120].replace("\n", " ") + "..."
            save_report_to_cache("掘金选股", "A股主力资金挖掘与值得建仓标的报告", summary, full_report)

    # 渲染历史卡片
    render_history_cards("掘金选股")

# -------------------- Tab 2: 个股深度分析与搜索 --------------------
with tab2:
    st.subheader("🔍 个股全景实时数据诊断")
    col_input1, col_input2 = st.columns([2, 1])
    with col_input1:
        search_code = st.text_input("输入6位A股代码 (如 300131 或 600519)", value="300131")
    with col_input2:
        add_to_hold = st.checkbox("设为我的持仓股", key="add_hold_check")

    if st.button("📊 抓取该股实时行情并一键全方位诊断", type="primary"):
        with st.spinner(f"正在抓取股票 [{search_code}] 的实时行情、主力资金与全网资讯..."):
            spot_info = RealTimeADataFetcher.get_stock_spot(search_code)
            news_list = RealTimeADataFetcher.get_realtime_news()
            
            st.markdown("#### 📈 实时行情与主力资金数据")
            col_m1, col_m2, col_m3, col_m4, col_m5 = st.columns(5)
            col_m1.metric("股票名称", f"{spot_info['name']} ({spot_info['code']})")
            col_m2.metric("当前最新价", f"{spot_info['price']} 元", f"{spot_info['change_pct']}%")
            col_m3.metric("主力资金净流入", f"{spot_info['main_net_inflow_yi']} 亿元")
            col_m4.metric("换手率", f"{spot_info['turnover_rate']}%")
            col_m5.metric("市盈率(TTM)", f"{spot_info['pe_ttm']}")

            prompt = f"""
            请对股票【{spot_info['name']} ({spot_info['code']})】进行深度分析。

            该股【实时抓取到的行情数据】如下：
            - 最新价格: {spot_info['price']} 元
            - 今日涨跌幅: {spot_info['change_pct']}%
            - 主力资金净流入: {spot_info['main_net_inflow_yi']} 亿元
            - 换手率: {spot_info['turnover_rate']}%
            - 市盈率 TTM: {spot_info['pe_ttm']}

            最新 24 小时市场快讯背景：
            {json.dumps(news_list[:5], ensure_ascii=False, indent=2)}

            请基于以上数据，从资金面、技术面、基本面与近期消息面进行全方位诊断，并给出明确的操作建议（加仓、观望、减仓或止损）。
            """
            
            full_analysis = call_llm(prompt)
            st.markdown("### 💡 AI 深度诊断与操作建议")
            st.markdown(full_analysis)
            
            if add_to_hold and search_code not in st.session_state['holdings']:
                st.session_state['holdings'].append(search_code)
                st.success(f"已将 {search_code} 加入持仓股清单！")
                
            summary = f"{spot_info['name']}({spot_info['code']}) 当前价: {spot_info['price']}元, 主力净流入: {spot_info['main_net_inflow_yi']}亿。建议概览: {full_analysis[:80]}..."
            save_report_to_cache("个股分析", f"个股全景诊断报告 - {spot_info['name']}({search_code})", summary, full_analysis, stock_code=search_code)

    # 渲染历史卡片
    render_history_cards("个股分析")

# -------------------- Tab 3: 持仓股管理与晨报预警 --------------------
with tab3:
    st.subheader("📋 持仓股监控与 24h 舆情预警")
    
    current_holdings = st.multiselect(
        "托管监控的持仓股清单：", 
        options=list(set(st.session_state['holdings'] + ["600519", "300131", "000001", "300750"])),
        default=st.session_state['holdings']
    )
    st.session_state['holdings'] = current_holdings

    if st.button("📥 触发持仓股 24h 舆情与资金面深度晨报预警", type="primary"):
        if not current_holdings:
            st.warning("请先选择或添加持仓股票！")
        else:
            with st.spinner("正在并发拉取所有持仓股实时资金流向与全网快讯..."):
                holdings_spots = [RealTimeADataFetcher.get_stock_spot(code) for code in current_holdings]
                news_list = RealTimeADataFetcher.get_realtime_news()
                
                st.markdown("#### 📊 当前持仓股实时盘面汇总")
                st.dataframe(pd.DataFrame(holdings_spots), use_container_width=True)

                prompt = f"""
                请针对用户持仓股票列表进行晨报预警分析。

                【持仓股实时数据汇总】：
                {json.dumps(holdings_spots, ensure_ascii=False, indent=2)}

                【最新 24 小时市场舆情与快讯】：
                {json.dumps(news_list, ensure_ascii=False, indent=2)}

                请总结生成【持仓股晨报预警报告】：
                1. 24小时内持仓股盘面异动与资金流向分析（重点标记资金大幅净流出的标的）。
                2. 结合快讯，排查重大公告、辟谣或舆情利好/利空。
                3. 给出明确的持仓风险预警提醒与应对预案。
                """
                
                morning_report = call_llm(prompt)
                st.markdown("### 🔔 持仓股晨报预警面板")
                st.markdown(morning_report)
                
                summary = morning_report[:120].replace("\n", " ") + "..."
                save_report_to_cache("持仓预警", f"每日持仓晨报与预警 ({', '.join(current_holdings)})", summary, morning_report)

    # 渲染历史卡片
    render_history_cards("持仓预警")

# -------------------- Tab 4: 智能风控与仓位策略 --------------------
with tab4:
    st.subheader("⚖️ 动态仓位管理与风控模型")
    st.info("💡 核心纪律：盈利时减仓锁定利润并留底仓跟随趋势；亏损时不盲目补仓亦不恐慌割肉。")
    
    col_r1, col_r2 = st.columns(2)
    with col_r1:
        risk_code = st.selectbox("选择持仓标的", st.session_state['holdings'] if st.session_state['holdings'] else ["300131"])
        p_status = st.radio("盈亏状态", ["当前盈利", "当前亏损"])
    with col_r2:
        profit_pct = st.slider("浮动盈亏比例 (%)", -50.0, 100.0, 10.0)
        position_pct = st.slider("当前该股仓位占比 (%)", 5, 100, 30)

    if st.button("🛡️ 计算动态风控策略与执行方案", type="primary"):
        spot_info = RealTimeADataFetcher.get_stock_spot(risk_code)
        
        prompt = f"""
        用户持有标的 [{spot_info['name']} ({risk_code})]。
        实时最新价: {spot_info['price']} 元，主力资金净流入: {spot_info['main_net_inflow_yi']} 亿元。
        用户持仓状态: 【{p_status}】，浮动盈亏: {profit_pct}%，当前仓位占比: {position_pct}%。

        请严格基于风控纪律（拒绝情绪化、禁止盲目补仓或恐慌割肉，盈利分批锁利留底仓），给出具体的仓位调整阶梯策略与心法约束。
        """
        
        risk_advice = call_llm(prompt)
        st.markdown("### 🛡️ 智能风控建议")
        st.markdown(risk_advice)
        
        summary = f"标的: {spot_info['name']}({risk_code}), 状态: {p_status}{profit_pct}%, 建议概览: {risk_advice[:80]}..."
        save_report_to_cache("风控策略", f"风控仓位策略 - {spot_info['name']}({risk_code})", summary, risk_advice, stock_code=risk_code)

    # 渲染历史卡片
    render_history_cards("风控策略")
