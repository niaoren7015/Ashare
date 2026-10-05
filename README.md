# A股智能投资管理系统 v0.2

Cloudflare Workers + D1 + Static Assets。

核心：股票实时行情、日K线、技术指标、持仓/交易、盈亏、预警、AI模型配置、8:00北京时间定时任务、数据源健康状态。

默认行情源为东方财富公开接口。系统不会伪造不存在的“免费同花顺实时接口”；同花顺官方权限接口通过适配器预留。

全程可浏览器部署：GitHub + Cloudflare，不需要本地 Node/Git/Python/Wrangler。D1 绑定后 Worker 首次访问自动初始化表结构。