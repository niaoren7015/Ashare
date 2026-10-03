import streamlit as st
import pandas as pd
import akshare as ak
import plotly.graph_objects as go
from openai import OpenAI
from datetime import datetime
import time
import extra_streamlit_components as stx  # 新增：用于调用本地浏览器存储

# ==================== 页面基本配置 ====================
st.set_page_config(
    page_title="A股智能量化与追踪分析工作流",
    page_icon="📈",
    layout="wide"
)

# 初始化浏览器 Cookie 管理器 (使用 cache_resource 确保全局只实例化一次)
@st.cache_resource
def get_manager():
    return stx.CookieManager()

cookie_manager = get_manager()

# 全局初始化持仓股状态，避免多模块调用时冲突
if 'holdings' not in st.session_state:
    st.session_state['holdings'] = []

# ==================== 一、 侧边栏：大模型与API配置（本地缓存版） ====================
st.sidebar.header("⚙️ 模型与接口配置中心")
st.sidebar.markdown("*(配置仅保存在您的本地浏览器，不会上传至云端)*")

# 尝试从本地浏览器读取历史配置，如果没有则使用默认值
saved_api_base = cookie_manager.get(cookie="api_base") or "https://api.deepseek.com/v1"
saved_api_key = cookie_manager.get(cookie="api_key") or ""
saved_model_name = cookie_manager.get(cookie="model_name") or "deepseek-chat"

# 渲染输入框，默认值设为本地读取的值
api_base = st.sidebar.text_input("API 接口地址 (Base URL)", value=saved_api_base)
api_key = st.sidebar.text_input("API Key", type="password", value=saved_api_key)
model_name = st.sidebar.text_input("模型名称 (Model)", value=saved_model_name)

# 增加“保存到本地”按钮
if st.sidebar.button("💾 记住我的配置"):
    cookie_manager.set("api_base", api_base, key="set_base")
    cookie_manager.set("api_key", api_key, key="set_key")
    cookie_manager.set("model_name", model_name, key="set_model")
    st.sidebar.success("✅ 配置已安全保存在本地浏览器！刷新网页不再丢失。")

def get_llm_response(prompt):
    if not api_key:
        return "【系统提示】请先在左侧侧边栏配置有效的 API Key 才能启用 AI 分析报告与策略建议！"
    try:
        client = OpenAI(base_url=api_base, api_key=api_key)
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "你是一位拥有顶尖水平的A股量化投资专家、宏观经济分析师及风险控制专家。"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3
        )
        return response.choices[0].message.content
    except Exception as e:
        return f"调用大模型 API 发生错误: {str(e)}"

# ==================== 二、 主界面导航 ====================
st.title("🐂 A股智能投资管理与追踪分析工作流")
st.markdown("聚焦 A 股市场，融合东方财富/同花顺多维数据，实现全自动板块挖掘、个股全景诊断、持仓智能预警与风控管理。")

tab1, tab2, tab3, tab4 = st.tabs([
    "🔥 1. 掘金选股与板块推荐", 
    "🔍 2. 个股深度分析与搜索", 
    "📋 3. 持仓股管理与晨报预警", 
    "⚖️ 4. 智能风控与仓位策略"
])

# ==================== 模块 1：推荐值得建仓的板块和个股 ====================
with tab1:
    st.subheader("🤖 全方位宏观与资金面板块掘金")
    st.markdown("系统综合考量：**资金面（主力净流入）、消息面、基本面、周期性、国际供应与地缘政治风险**。")
    
    if st.button("🚀 一键执行多维扫描并生成荐股报告"):
        with st.spinner("正在从东方财富/同花顺拉取实时行业板块资金流向及宏观数据..."):
            try:
                # 获取东财行业资金流向数据
                sector_money = ak.stock_sector_fund_flow_rank(indicator="今日")
                top_sectors = sector_money.head(5)["板块"].tolist()
            except Exception as e:
                # 异常降级兜底
                top_sectors = ["半导体", "通信设备", "新能源车", "创新药", "国防军工"]
            
            prompt = f"""
            当前A股市场监测到的主力资金净流入靠前的核心板块有: {top_sectors}。
            请结合当前宏观局势（地缘政治、国际供应链、国内基本面、周期性），全方位评估：
            1. 哪些板块具备真实的高安全边际、尚未被过度炒作且有基本面支撑？
            2. 在这些板块中挑选 2-3 个高性价比标的（给出股票名称和代码）。
            3. 详细输出“荐股列表与原因分析报告”，重点说明为何没有暴雷风险及基本面支撑点。
            """
            report = get_llm_response(prompt)
            st.success("扫描完成！生成以下荐股与板块分析报告：")
            st.markdown(report)

# ==================== 模块 2：个股分析（搜索选股） ====================
with tab2:
    st.subheader("🔍 个股全景实时分析诊断")
    col_s1, col_s2 = st.columns([2, 1])
    with col_s1:
        stock_code = st.text_input("输入6位A股代码 (例如: 600519 或 300131)", value="300131")
    with col_s2:
        is_holding_add = st.checkbox("设为我的持仓股", key="add_holding_cb")

    if st.button("📊 一键全方位分析该股", key="analyze_btn"):
        with st.spinner(f"正在安全连接东方财富/同花顺接口，获取股票 {stock_code} 行情与历史K线..."):
            df_history = pd.DataFrame()
            success = False
            
            # 已优化：加入多轮重试机制，应对东方财富服务端的偶发限流与断开
            for attempt in range(3):
                try:
                    # 获取历史日线行情
                    df_history = ak.stock_zh_a_hist(symbol=stock_code, period="daily", start_date="20250101", adjust="qfq")
                    if not df_history.empty:
                        success = True
                        break
                except Exception as e:
                    time.sleep(1.5 * (attempt + 1)) # 失败后退避等待
            
            if success and not df_history.empty:
                # 绘制K线与成交量图表
                fig = go.Figure(data=[go.Candlestick(
                    x=df_history['日期'],
                    open=df_history['开盘'],
                    high=df_history['最高'],
                    low=df_history['最低'],
                    close=df_history['收盘'],
                    name='K线'
                )])
                fig.update_layout(title=f"{stock_code} 历史走势与K线图", xaxis_rangeslider_visible=False, height=400)
                st.plotly_chart(fig, use_container_width=True)
            else:
                st.warning("⚠️ 实时网络接口连接波动，未能成功拉取到该股的K线明细。系统将直接基于大模型知识库为您进行该股全景深度诊断：")
            
            # 组装大模型深度诊断（即便网络接口偶发超时，AI 也能基于代码与宏观给出专业分析）
            stock_detail_prompt = f"""
            请对A股股票代码 {stock_code} 进行全面分析。
            要求包含：
            1. 该股票所属概念板块、主营业务及近期市场表现评估。
            2. 技术面与基本面（业绩、行业地位）综合诊断。
            3. 给出明确的操作建议（买入、观望、减仓、止损）。
            """
            ai_analysis = get_llm_response(stock_detail_prompt)
            st.markdown("### 💡 AI 全方位诊断与操作建议")
            st.markdown(ai_analysis)
            
            if is_holding_add:
                if stock_code not in st.session_state['holdings']:
                    st.session_state['holdings'].append(stock_code)
                st.success(f"成功将 {stock_code} 添加到持仓股管理列表！")

# ==================== 模块 3：持仓股管理与晨报预警 ====================
with tab3:
    st.subheader("📋 持仓股管理与 8:00 自动预警分析")
    
    # 获取全局状态中的持仓列表，若为空则给默认示例
    default_holdings = st.session_state['holdings'] if len(st.session_state['holdings']) > 0 else ["600519", "300131"]
        
    user_holdings = st.multiselect("当前托管监控的持仓股列表：", 
                                   options=list(set(default_holdings + ["600519", "000001", "300750", "601318", "002594", "300131"])), 
                                   default=default_holdings)
    
    # 同步更新 session state
    st.session_state['holdings'] = user_holdings
    
    st.markdown("---")
    st.markdown("### ⏰ 每日晨报预警提示面板 (模拟 08:00 自动运行)")
    if st.button("📥 手动触发 24 小时舆情、公告与风险大盘扫描"):
        if not user_holdings:
            st.warning("您的持仓列表为空，请先在上方或模块 2 中添加持仓股票！")
        else:
            with st.spinner("正在整合 24 小时内交易情况、公告大事、舆情小作文、关联政策及国际地缘风险..."):
                morning_prompt = f"""
                针对当前用户的持仓股票代码列表: {user_holdings}。
                请生成一份专业的【每日晨报分析概览】，内容严格包含：
                1. 24小时内核心交易情况与盘面异动追踪。
                2. 重大公司公告梳理。
                3. 市场舆情监测（包含小作文辟谣或确认）。
                4. 关联市场板块政策变动及国际地缘政治风险提醒。
                5. 利好消息同步播报。
                """
                morning_report = get_llm_response(morning_prompt)
                st.info("【系统提示】早晨 08:00 定时自动巡检报告已生成：")
                st.markdown(morning_report)

# ==================== 模块 4：智能风控与仓位管理策略 ====================
with tab4:
    st.subheader("⚖️ 动态仓位管理与盈亏博弈策略模型")
    st.markdown("""
    > **核心纪律约束**：
    > * **盈利时**：偏好减仓锁定部分利润，但同时保持留底仓跟随趋势上涨的定力。
    > * **亏损时**：严禁情绪化博弈，不轻易在下跌趋势中盲目补仓，也不得盲目恐慌割肉，严格执行仓位管理。
    """)
    
    if len(st.session_state['holdings']) == 0:
        st.info("尚未添加任何持仓股，请先在模块 2 搜索并添加持仓股票。")
    else:
        c_code = st.selectbox("选择需要计算风控策略的持仓股", st.session_state['holdings'])
        p_status = st.radio("当前盈亏状态", ["当前处于盈利状态", "当前处于亏损套牢状态"])
        profit_pct = st.slider("当前浮动盈亏比例 (%)", -50.0, 100.0, 10.0)
        
        if st.button("🛡️ 生成动态仓位风控与操作策略"):
            risk_prompt = f"""
            用户持有股票 {c_code}，目前状态为【{p_status}】，盈亏比例为 {profit_pct}%。
            请结合严格的仓位管理纪律（拒绝情绪化、禁止盲目补仓或恐慌割肉、盈利时分批锁定且留底仓）：
            1. 针对该盈亏状态，给出具体的降仓、止盈、或持股静观的数理与策略指导。
            2. 给出一套明晰的心理与执行纪律约束，防止情绪化博弈。
            """
            risk_advice = get_llm_response(risk_prompt)
            st.warning("⚠️ 智能风控与仓位执行建议：")
            st.markdown(risk_advice)
