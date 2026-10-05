import time
import json
import requests
import pandas as pd
import numpy as np
import plotly.graph_objects as go
import streamlit as st
from datetime import datetime, timedelta

# ==========================================
# 1. 页面基本配置与全局状态
# ==========================================
st.set_page_config(
    page_title="A股全方位智能投资研判与持仓管理系统",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded"
)

# 初始化 Session State
if "portfolio" not in st.session_state:
    # 默认示例持仓
    st.session_state.portfolio = {
        "600519": {"name": "贵州茅台", "cost": 1550.0, "shares": 200},
        "300750": {"name": "宁德时代", "cost": 180.0, "shares": 1000}
    }

if "selected_stock" not in st.session_state:
    st.session_state.selected_stock = "600519"

# ==========================================
# 2. 东方财富 (EastMoney) 真实数据抓取模块
# ==========================================
def get_secid(code: str) -> str:
    """根据股票代码判断交易所前缀 (0: 深圳/北京, 1: 上海)"""
    code = code.strip()
    if code.startswith(("6", "688", "900")):
        return f"1.{code}"
    elif code.startswith(("0", "3", "200", "8", "4", "920")):
        return f"0.{code}"
    return f"1.{code}"

@st.cache_data(ttl=15)
def fetch_realtime_quote(code: str) -> dict:
    """获取单只股票/指数实时行情"""
    secid = get_secid(code)
    url = "http://push2.eastmoney.com/api/qt/stock/get"
    params = {
        "secid": secid,
        "fields": "f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f84,f85,f116,f117,f162,f167,f168,f169,f170",
        "invt": "2"
    }
    try:
        resp = requests.get(url, params=params, timeout=4)
        data = resp.json().get("data", {})
        if not data:
            return {}
        
        # 东方财富数值除以 100/1000 处理
        price = data.get("f43", 0) / 100.0 if data.get("f43") != "-" else 0
        prev_close = data.get("f60", 0) / 100.0 if data.get("f60") != "-" else 0
        high = data.get("f44", 0) / 100.0 if data.get("f44") != "-" else 0
        low = data.get("f45", 0) / 100.0 if data.get("f45") != "-" else 0
        open_p = data.get("f46", 0) / 100.0 if data.get("f46") != "-" else 0
        
        change = price - prev_close if prev_close > 0 else 0
        pct_change = (change / prev_close * 100) if prev_close > 0 else 0

        return {
            "code": data.get("f57", code),
            "name": data.get("f58", "未知"),
            "price": price,
            "change": change,
            "pct_change": pct_change,
            "high": high,
            "low": low,
            "open": open_p,
            "prev_close": prev_close,
            "volume": data.get("f47", 0),  # 成交量(手)
            "amount": data.get("f48", 0),  # 成交额(元)
            "turnover_rate": data.get("f168", 0) / 100.0, # 换手率%
            "pe": data.get("f162", 0) / 100.0, # 动态市盈率
            "pb": data.get("f167", 0) / 100.0, # 市净率
            "total_mv": data.get("f116", 0), # 总市值
        }
    except Exception as e:
        return {}

@st.cache_data(ttl=60)
def fetch_kline_data(code: str, limit: int = 100) -> pd.DataFrame:
    """获取日K线历史数据"""
    secid = get_secid(code)
    url = "http://push2his.eastmoney.com/api/qt/stock/kline/get"
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101", # 日线
        "fqt": "1",   # 前复权
        "end": "20500101",
        "lmt": limit
    }
    try:
        resp = requests.get(url, params=params, timeout=5)
        data = resp.json().get("data", {})
        klines = data.get("klines", [])
        
        rows = []
        for k in klines:
            # 日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
            parts = k.split(",")
            rows.append({
                "Date": parts[0],
                "Open": float(parts[1]),
                "Close": float(parts[2]),
                "High": float(parts[3]),
                "Low": float(parts[4]),
                "Volume": float(parts[5]),
                "Amount": float(parts[6]),
                "PctChange": float(parts[8])
            })
        df = pd.DataFrame(rows)
        if not df.empty:
            df["Date"] = pd.to_datetime(df["Date"])
            # 计算均线
            df["MA5"] = df["Close"].rolling(5).mean()
            df["MA20"] = df["Close"].rolling(20).mean()
            df["MA60"] = df["Close"].rolling(60).mean()
        return df
    except Exception as e:
        return pd.DataFrame()

@st.cache_data(ttl=120)
def fetch_market_news_and_sectors() -> dict:
    """获取市场热门板块主力资金流向及最新快讯"""
    news_list = []
    sector_ranks = []
    
    # 1. 东方财富快讯抓取
    try:
        url_news = "https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_20_1_.html"
        resp = requests.get(url_news, timeout=4)
        text = resp.text
        if "var ajaxResult=" in text:
            text = text.replace("var ajaxResult=", "")
        json_data = json.loads(text)
        for item in json_data.get("LivesList", [])[:10]:
            news_list.append(f"[{item.get('showtime', '')}] {item.get('title', '')}: {item.get('digest', '')}")
    except Exception:
        news_list = ["全网最新宏观经济与A股要闻正在同步更新中..."]

    # 2. 行业板块资金流向排行榜 (前8名)
    try:
        url_sector = "http://82.push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": "8", "po": "1", "np": "1",
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fltt": "2", "invt": "2", "fid": "f62", # f62: 主力净流入额
            "fs": "m:90 t:2+f:!50",
            "fields": "f12,f14,f2,f3,f62,f184"
        }
        resp = requests.get(url_sector, params=params, timeout=4)
        diff = resp.json().get("data", {}).get("diff", [])
        for d in diff:
            sector_ranks.append({
                "sector_name": d.get("f14"),
                "pct_change": d.get("f3"),
                "main_fund_inflow_m": round(d.get("f62", 0) / 10000, 2), # 转换为万元
                "main_fund_ratio": d.get("f184", 0)
            })
    except Exception:
        pass

    return {"news": news_list, "sectors": sector_ranks}

# ==========================================
# 3. 通用自定义 LLM API 调用模块
# ==========================================
def call_custom_llm(base_url: str, api_key: str, model_name: str, system_prompt: str, user_prompt: str, temperature: float = 0.7) -> str:
    """
    通用 OpenAI 兼容接口调用逻辑（支持 DeepSeek, Qwen, OpenAI, Kimi, SiliconFlow 等）
    """
    if not api_key:
        return "⚠️ 请先在左侧边栏填写您的 大模型 API Key。"
    
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": temperature
    }
    
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=90)
        if resp.status_code == 200:
            res_json = resp.json()
            return res_json["choices"][0]["message"]["content"]
        else:
            return f"❌ API 请求失败 [HTTP {resp.status_code}]: {resp.text}"
    except Exception as e:
        return f"❌ 连接 LLM 服务异常: {str(e)}"

# ==========================================
# 4. 侧边栏：API 参数设置与导航
# ==========================================
st.sidebar.title("🛠️ 系统配置中心")

st.sidebar.subheader("🤖 LLM 模型 API 配置")
api_base_url = st.sidebar.text_input("接口地址 (Base URL)", value="https://api.deepseek.com/v1")
api_key = st.sidebar.text_input("API Key", type="password", value="")
model_name = st.sidebar.text_input("模型名称 (Model Name)", value="deepseek-chat")
temperature = st.sidebar.slider("采样温度 (Temperature)", 0.0, 1.0, 0.3, 0.1)

st.sidebar.markdown("---")
st.sidebar.subheader("📌 功能导航")
nav_option = st.sidebar.radio(
    "选择工作流模块:",
    ["💡 智能选股与建仓研判", "🔍 个股全方位深度分析", "💼 持仓管理与AI风控建议"]
)

# ==========================================
# 5. 模块 1：智能选股与建仓研判
# ==========================================
if nav_option == "💡 智能选股与建仓研判":
    st.header("💡 A股全方位板块筛选与建仓推荐")
    st.caption("综合【资金面、消息面、基本面、周期性、国际供应链、政治局势与宏观政策】进行全方位筛选。")
    
    market_data = fetch_market_news_and_sectors()
    
    col1, col2 = st.columns([1, 1])
    with col1:
        st.subheader("🔥 实时主力资金净流入前列板块 (东方财富)")
        if market_data["sectors"]:
            df_sec = pd.DataFrame(market_data["sectors"])
            df_sec.columns = ["板块名称", "涨跌幅(%)", "主力净流入(万元)", "主力占比(%)"]
            st.dataframe(df_sec, use_container_width=True)
        else:
            st.info("无法获取实时板块资金流向数据")
            
    with col2:
        st.subheader("📰 24小时市场核心快讯与舆情")
        for idx, news in enumerate(market_data["news"][:5]):
            st.write(f"**{idx+1}.** {news}")

    st.markdown("---")
    
    if st.button("🚀 运行 AI 全方位选股与建仓研判引擎", type="primary"):
        with st.spinner("AI 正在综合评估资金流向、国际局势、基本面与估值安全边际，生成推荐研报..."):
            system_prompt = """你是一位精通A股市场、宏观经济学、产业链周期与政治风险管理的资深首席策略分析师。
你的选股哲学是：强调安全边际，拒绝追高已暴涨题材，寻找有基本面支撑、处于估值低位、受资金关注且无暴雷风险的优质标的。"""

            user_prompt = f"""
请结合以下东方财富提供的最新实时市场数据与国际宏观背景，生成一份【A股建仓推荐研判报告】：

【最新主力资金流入板块】：
{json.dumps(market_data['sectors'], ensure_ascii=False)}

【最新市场核心资讯/宏观动态】：
{chr(10).join(market_data['news'])}

请严格包含以下四大核心模块输出：
1. **当前市场宏观与国际局势风险评估**：分析政治风险、供应链变动、美联储/央行政策对A股的影响。
2. **重点推荐建仓板块 (2-3个)**：结合资金面、周期性与安全边际，说明推荐理由。
3. **精选标的推荐列表 (3-5支个股)**：
   - 提供 股票代码、股票名称、所属板块。
   - 核心推荐逻辑（基本面支撑、估值修复、安全边际、催化剂）。
   - 建议建仓区间与风控止损位。
4. **建仓策略与仓位管理建议**：如何在当前大盘环境下分批建仓。
"""
            report = call_custom_llm(api_base_url, api_key, model_name, system_prompt, user_prompt, temperature)
            st.markdown(report)

# ==========================================
# 6. 模块 2：个股全方位深度分析
# ==========================================
elif nav_option == "🔍 个股全方位深度分析":
    st.header("🔍 个股全方位深度分析与走势研判")
    
    search_col1, search_col2 = st.columns([1, 3])
    with search_col1:
        input_code = st.text_input("输入股票代码 (如 600519 / 300750 / 000001):", value=st.session_state.selected_stock)
        if st.button("查询股票信息"):
            st.session_state.selected_stock = input_code.strip()
            
    stock_code = st.session_state.selected_stock
    quote = fetch_realtime_quote(stock_code)
    
    if not quote or not quote.get("name"):
        st.error(f"❌ 无法查询到股票代码 [{stock_code}] 的实时行情，请检查代码输入是否正确。")
    else:
        # 1. 实时行情看板
        st.subheader(f"📌 {quote['name']} ({quote['code']}) 实时行情")
        
        m1, m2, m3, m4, m5, m6 = st.columns(6)
        m1.metric("当前价", f"￥{quote['price']:.2f}", f"{quote['change']:+.2f} ({quote['pct_change']:+.2f}%)")
        m2.metric("最高价", f"￥{quote['high']:.2f}")
        m3.metric("最低价", f"￥{quote['low']:.2f}")
        m4.metric("换手率", f"{quote['turnover_rate']:.2f}%")
        m5.metric("市盈率(动)", f"{quote['pe']:.2f}")
        m6.metric("市净率", f"{quote['pb']:.2f}")
        
        # 2. 绘制 Plotly 交互式 K 线图
        df_kline = fetch_kline_data(stock_code)
        if not df_kline.empty:
            fig = go.Figure()
            # K线
            fig.add_trace(go.Candlestick(
                x=df_kline['Date'],
                open=df_kline['Open'],
                high=df_kline['High'],
                low=df_kline['Low'],
                close=df_kline['Close'],
                name='日K线',
                increasing_line_color='red', decreasing_line_color='green'
            ))
            # 均线
            fig.add_trace(go.Scatter(x=df_kline['Date'], y=df_kline['MA5'], mode='lines', name='MA5', line=dict(width=1)))
            fig.add_trace(go.Scatter(x=df_kline['Date'], y=df_kline['MA20'], mode='lines', name='MA20', line=dict(width=1.5)))
            fig.add_trace(go.Scatter(x=df_kline['Date'], y=df_kline['MA60'], mode='lines', name='MA60', line=dict(width=2)))
            
            fig.update_layout(
                title=f"{quote['name']} ({quote['code']}) 历史K线趋势 (附均线)",
                xaxis_title="日期",
                yaxis_title="价格 (元)",
                height=450,
                xaxis_rangeslider_visible=False,
                margin=dict(l=20, r=20, t=40, b=20)
            )
            st.plotly_chart(fig, use_container_width=True)
        
        # 3. 操作按钮组
        col_btn1, col_btn2 = st.columns([1, 1])
        with col_btn1:
            if st.button("➕ 一键将该股设为持仓管理目标"):
                if stock_code not in st.session_state.portfolio:
                    st.session_state.portfolio[stock_code] = {
                        "name": quote['name'],
                        "cost": quote['price'],
                        "shares": 1000
                    }
                    st.success(f"成功将 {quote['name']} 加入持仓列表！请前往【持仓管理】修改成本价与持仓量。")
                else:
                    st.info("该股票已在您的持仓列表中。")

        # 4. 智能全方位 AI 分析研判
        st.markdown("---")
        st.subheader("🧠 AI 智能全方位深度研判 (24h走势/公告大事/舆情风险)")
        
        if st.button("⚡ 触发一键全方位智能研判", type="primary"):
            with st.spinner(f"正在对 {quote['name']} 进行资金面、消息面、技术面及地缘政治风险综合诊断..."):
                system_prompt = """你是一位客观、严谨、谙熟A股主力资金动向与公司基本面分析的首席个股策略师。
请针对给定的股票实时数据，给出专业、深度、切中要害的研判说明，避免套话。"""

                user_prompt = f"""
f"请对股票【{quote['name']} ({quote['code']})】进行全方位研判。"

【实时交易数据】：
- 当前价: {quote['price']}元 | 涨跌幅: {quote['pct_change']:.2f}% | 昨收: {quote['prev_close']}元
- 今日最高: {quote['high']}元 | 今日最低: {quote['low']}元
- 换手率: {quote['turnover_rate']}% | 动态PE: {quote['pe']} | 市净率PB: {quote['pb']}

【近期近3日价格走势特征】：
{df_kline.tail(3)[['Date', 'Close', 'PctChange', 'Volume']].to_string() if not df_kline.empty else '无K线数据'}

请给出包含以下结构的深度研判报告：
1. **24小时交易情况与资金面点评**：分析价格位置、换手率与技术指标（均线组合）。
2. **公告大事与舆情小作文风险排查**：列出可能影响该股票的行业动态、潜在暴雷风险（如减持、商誉、质押、监管）。
3. **相关关联板块与宏观/国际局势风险提醒**：相关上游供应链、国际局势变动对该个股的利好/利空影响。
4. **综合研判概览与明确操作建议**：给出【观望 / 逢低分批建仓 / 减仓规避 / 坚定持有】结论及关键支撑位/压力位。
"""
                analysis_result = call_custom_llm(api_base_url, api_key, model_name, system_prompt, user_prompt, temperature)
                st.markdown(analysis_result)

# ==========================================
# 7. 模块 3：持仓管理与 AI 风控建议
# ==========================================
elif nav_option == "💼 持仓管理与AI风控建议":
    st.header("💼 我的持仓管理与 AI 动态风控系统")
    st.caption("实时计算持仓盈亏，结合理性仓位管理模型（拒绝情绪化博弈、不盲目向下补仓、止盈留底仓）提供决策建议。")
    
    # 1. 持仓设置与添加表单
    with st.expander("➕ 添加 / 编辑持仓股票数据"):
        c1, c2, c3, c4 = st.columns([1.5, 2, 2, 1])
        add_code = c1.text_input("股票代码", value="000001")
        add_cost = c2.number_input("持仓成本价 (元)", value=10.0, step=0.1)
        add_shares = c3.number_input("持仓数量 (股)", value=1000, step=100)
        
        if c4.button("保存持仓"):
            q = fetch_realtime_quote(add_code.strip())
            name = q.get("name", "自定义股票")
            st.session_state.portfolio[add_code.strip()] = {
                "name": name,
                "cost": float(add_cost),
                "shares": int(add_shares)
            }
            st.success(f"已更新 {name} ({add_code}) 的持仓数据！")
            st.rerun()

    # 2. 持仓实时统计与算数展示
    if not st.session_state.portfolio:
        st.info("当前暂无持仓股票，请在上方添加持仓或从个股分析界面加入。")
    else:
        portfolio_rows = []
        total_market_val = 0.0
        total_cost_val = 0.0
        
        for code, info in list(st.session_state.portfolio.items()):
            q = fetch_realtime_quote(code)
            curr_price = q.get("price", info["cost"])
            
            cost_val = info["cost"] * info["shares"]
            market_val = curr_price * info["shares"]
            pnl_val = market_val - cost_val
            pnl_pct = (pnl_val / cost_val * 100) if cost_val > 0 else 0
            
            total_cost_val += cost_val
            total_market_val += market_val
            
            portfolio_rows.append({
                "代码": code,
                "股票名称": info["name"],
                "当前价(元)": round(curr_price, 2),
                "成本价(元)": round(info["cost"], 2),
                "持仓股数": info["shares"],
                "持仓市值(元)": round(market_val, 2),
                "盈亏金额(元)": round(pnl_val, 2),
                "盈亏比例(%)": round(pnl_pct, 2),
                "日内涨跌幅(%)": round(q.get("pct_change", 0), 2)
            })

        df_port = pd.DataFrame(portfolio_rows)
        
        # 总体资产看板
        tot_pnl = total_market_val - total_cost_val
        tot_pnl_pct = (tot_pnl / total_cost_val * 100) if total_cost_val > 0 else 0
        
        p1, p2, p3 = st.columns(3)
        p1.metric("持仓总市值", f"￥{total_market_val:,.2f}")
        p2.metric("持仓总成本", f"￥{total_cost_val:,.2f}")
        p3.metric("累计总盈亏", f"￥{tot_pnl:,.2f}", f"{tot_pnl_pct:+.2f}%")
        
        st.subheader("📋 详细持仓清单")
        
        # 表格颜色渲染
        def style_pnl(val):
            color = 'red' if val > 0 else 'green' if val < 0 else 'black'
            return f'color: {color}; font-weight: bold;'

        st.dataframe(
            df_port.style.applymap(style_pnl, subset=['盈亏金额(元)', '盈亏比例(%)', '日内涨跌幅(%)']),
            use_container_width=True
        )
        
        # 移除持仓操作
        remove_code = st.selectbox("选择要删除的持仓股票:", options=list(st.session_state.portfolio.keys()))
        if st.button("🗑️ 从持仓中移除该股"):
            del st.session_state.portfolio[remove_code]
            st.success(f"已移除代码 {remove_code}")
            st.rerun()

        # 3. AI 结合持仓情况的风控策略研判
        st.markdown("---")
        st.subheader("🤖 AI 持仓风控与仓位管理优化建议")
        
        selected_eval_code = st.selectbox(
            "选择需要 AI 进行持仓风控研判的股票:",
            options=list(st.session_state.portfolio.keys()),
            format_func=lambda x: f"{st.session_state.portfolio[x]['name']} ({x})"
        )
        
        if st.button("🎯 生成持仓专属风控操作建议", type="primary"):
            target_info = st.session_state.portfolio[selected_eval_code]
            q_target = fetch_realtime_quote(selected_eval_code)
            
            curr_p = q_target.get("price", target_info["cost"])
            cost_p = target_info["cost"]
            pnl_pct = ((curr_p - cost_p) / cost_p * 100) if cost_p > 0 else 0
            
            with st.spinner(f"正在结合您的成本价（￥{cost_p}）和当前行情分析最佳操作策略..."):
                system_prompt = """你是一位精通仓位管理与交易心理学的资深风控总监。
在指导用户持仓时，你必须严格遵循以下原则：
1. **理性止盈**：盈利较大时，偏好“分批减仓锁定利润”，同时“保留底仓跟随趋势上涨”。
2. **严禁情绪化盲目补仓**：在下跌趋势中不轻易左侧加仓摊成本，除非出现明显的底背离或基本面反转信号。
3. **拒绝恐慌割肉**：若因大盘情绪杀跌但基本面未变，不轻易低位割肉，给出明确的破位止损位。
4. **注重整体仓位平衡**：结合宏观风险调整仓位。"""

                user_prompt = f"""
请针对我的持仓股票【{target_info['name']} ({selected_eval_code})}】结合我的实际持仓成本，给出具体的风控与操作建议：

【我的持仓数据】：
- 持仓成本价: {cost_p}元
- 持仓数量: {target_info['shares']}股
- 当前市场价: {curr_p}元
- 浮动盈亏比例: {pnl_pct:+.2f}%

【该股实时市场行情】：
- 今日涨跌幅: {q_target.get('pct_change', 0):+.2f}% | 换手率: {q_target.get('turnover_rate', 0)}%
- 市盈率PE: {q_target.get('pe', 0)} | 市净率PB: {q_target.get('pb', 0)}

请给出具体的研判分析：
1. **当前持仓盈亏状态评估**：分析当前成本位置的安全度（处于相对高位还是低位）。
2. **止盈/止损/减仓具体操作计划**：
   - 如果盈利：何时分批减仓锁定利润？建议保留多少百分比的底仓？
   - 如果亏损/被套：是否处于下跌趋势？为什么**不建议**此时盲目补仓？给出明确的技术破位止损离场点。
3. **仓位管理与下一步行动指引**：明确说明下一步是【继续观望/按计划减仓/锁盈/设防守位】。
"""
                advice = call_custom_llm(api_base_url, api_key, model_name, system_prompt, user_prompt, temperature)
                st.markdown(advice)

# ==========================================
# 8. 页脚说明
# ==========================================
st.markdown("---")
st.caption("⚠️️ **免责声明**：本系统基于大语言模型与第三方公开数据 API（东方财富）提供分析服务，生成的所有内容仅供投资研究参考，不构成任何具体的买卖投资建议。股市有风险，入市需谨慎。")
