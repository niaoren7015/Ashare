import re
import time
import requests
import pandas as pd
import streamlit as st
from datetime import datetime

# ==========================================
# 1. 页面配置与基础设置
# ==========================================
st.set_page_config(
    page_title="A股大盘指数实时监控 (带接口数据纠偏系统)",
    page_icon="📈",
    layout="wide"
)

st.title("📈 A股大盘指数实时监控与数据熔断纠偏")
st.caption("集成了数值放大校准（/100）、点数与百分比混淆自动修复以及数据异常断言机制。")

# ==========================================
# 2. 核心数据清洗与纠偏逻辑
# ==========================================
def sanitize_index_data(symbol: str, name: str, raw_price_val: float, raw_change_val: float, raw_pct_val: float) -> dict:
    """
    对接口抓取到的原始数据进行纠偏和清洗
    """
    price = float(raw_price_val)
    change = float(raw_change_val)
    pct = float(raw_pct_val)
    
    warnings = []

    # ------------------------------------
    # 防错逻辑 1: 数值放大 100 倍自动纠偏 (如 384219.0 -> 3842.19)
    # ------------------------------------
    if price > 50000.0:
        price /= 100.0
        change /= 100.0
        warnings.append("检测到价格数值放大100倍，已自动缩小100倍处理。")

    # ------------------------------------
    # 防错逻辑 2: 修正点数与百分比混淆 Bug
    # ------------------------------------
    # 根据当前价格和涨跌点数，反算真实的昨收价与真实百分比
    prev_close = price - change if price != change else price
    correct_pct = (change / prev_close * 100.0) if prev_close > 0 else 0.0

    # 如果接口返回的 pct 绝对值 > 20%（现行交易规则极罕见），或者与算出的 pct 偏差过大
    if abs(pct) > 20.0 or abs(pct - correct_pct) > 0.5:
        warnings.append(f"检测到百分比字段异常 (原值: {pct}%)，疑将点数误当作幅度，已自动按点数重算为 {correct_pct:.2f}%。")
        pct = correct_pct

    # ------------------------------------
    # 防错逻辑 3: 数值合理性熔断校验 (Sanity Check)
    # ------------------------------------
    is_valid = True
    error_msg = ""
    if not (500.0 <= price <= 30000.0):
        is_valid = False
        error_msg = f"价格 {price} 超出 A 股指数正常合理区间 [500, 30000]"
    elif abs(pct) > 20.0:
        is_valid = False
        error_msg = f"纠偏后涨跌幅 {pct:.2f}% 仍超出单日最大波动上限限制"

    return {
        "symbol": symbol,
        "name": name,
        "price": round(price, 2),
        "change": round(change, 2),
        "pct": round(pct, 2),
        "is_valid": is_valid,
        "error_msg": error_msg,
        "warnings": " | ".join(warnings) if warnings else "无异常"
    }

# ==========================================
# 3. 数据拉取模块 (支持主备数据源)
# ==========================================
def fetch_from_tencent() -> list:
    """拉取腾讯财经简易行情接口"""
    url = "http://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006"
    resp = requests.get(url, timeout=3)
    resp.encoding = "gbk"
    text = resp.text
    
    results = []
    # 匹配 v_s_sh000001="1~上证指数~000001~3842.19~31.00~0.81~..."
    pattern = re.compile(r'v_(s_[a-z0-9]+)="(.*?)"')
    matches = pattern.findall(text)
    
    for symbol, content in matches:
        fields = content.split("~")
        if len(fields) >= 6:
            results.append({
                "symbol": symbol,
                "raw_name": fields[1],
                "raw_price": fields[3],
                "raw_change": fields[4],
                "raw_pct": fields[5]
            })
    return results

def fetch_from_sina() -> list:
    """备用源：拉取新浪财经行情接口"""
    url = "http://hq.sinajs.cn/list=s_sh000001,s_sz399001,s_sz399006"
    headers = {"Referer": "https://finance.sina.com.cn"}
    resp = requests.get(url, headers=headers, timeout=3)
    resp.encoding = "gbk"
    text = resp.text

    results = []
    pattern = re.compile(r'hq_str_(s_[a-z0-9]+)="(.*?)"')
    matches = pattern.findall(text)

    for symbol, content in matches:
        fields = content.split(",")
        if len(fields) >= 4:
            results.append({
                "symbol": symbol,
                "raw_name": fields[0],
                "raw_price": fields[1],
                "raw_change": fields[2],
                "raw_pct": fields[3]
            })
    return results

def get_market_data():
    """获取并清洗数据，自动切源"""
    raw_list = []
    source_used = "腾讯财经 (Tencent)"
    try:
        raw_list = fetch_from_tencent()
    except Exception as e:
        source_used = f"新浪财经 (Sina - 腾讯源失效: {str(e)})"
        try:
            raw_list = fetch_from_sina()
        except Exception as e2:
            st.error(f"所有数据源均无法访问: {e2}")
            return [], "无", []

    cleaned_list = []
    for item in raw_list:
        cleaned = sanitize_index_data(
            symbol=item["symbol"],
            name=item["raw_name"],
            raw_price_val=item["raw_price"],
            raw_change_val=item["raw_change"],
            raw_pct_val=item["raw_pct"]
        )
        cleaned_list.append(cleaned)

    return cleaned_list, source_used, raw_list

# ==========================================
# 4. 前端渲染逻辑
# ==========================================
# 侧边栏控制
st.sidebar.header("⚙️ 监控面板设置")
auto_refresh = st.sidebar.checkbox("开启自动刷新 (5秒/次)", value=False)
if st.sidebar.button("🔄 手动刷新数据"):
    st.rerun()

# 拉取数据
data_list, current_source, raw_data_list = get_market_data()

st.sidebar.info(f"当前数据源: **{current_source}**")
st.sidebar.text(f"最后更新时间:\n{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

# 展示核心三大指数 Metric 卡片
if data_list:
    cols = st.columns(len(data_list))
    for idx, item in enumerate(data_list):
        with cols[idx]:
            if item["is_valid"]:
                delta_str = f"{item['change']:+.2f} ({item['pct']:+.2f}%)"
                st.metric(
                    label=item["name"],
                    value=f"{item['price']:.2f}",
                    delta=delta_str
                )
            else:
                st.error(f"{item['name']} 数据严重异常！")
                st.caption(item["error_msg"])

st.markdown("---")

# 详细数据与纠偏日志展示
st.subheader("🔍 数据纠偏与清洗审计日志")
if data_list:
    df = pd.DataFrame(data_list)
    # 重命名便于阅读
    display_df = df[["name", "symbol", "price", "change", "pct", "is_valid", "warnings"]].rename(
        columns={
            "name": "指数名称",
            "symbol": "代码",
            "price": "校准后收盘/点数",
            "change": "校准后涨跌额",
            "pct": "校准后涨跌幅 (%)",
            "is_valid": "数据校验通过",
            "warnings": "触发的纠偏规则说明"
        }
    )
    st.dataframe(display_df, use_container_width=True)

# 原始 API 数据探针（方便调试接口偏移）
with st.expander("🛠️ 查看原始 API 返回内容 (Debug Inspector)"):
    st.json(raw_data_list)

# 自动刷新逻辑
if auto_refresh:
    time.sleep(5)
    st.rerun()
