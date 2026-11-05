# Changelog

## 0.3.2 — 2026-11-06

- 修复设置面板切换峰时策略时报 `Unexpected end of JSON input`：Host 启动顺序可能让 `webServer` 在插件 apply 时尚未就绪，导致设置路由根本没注册；改用 `ctx.inject(['webServer'], ...)` 后再挂载路由。
- 客户端对非 JSON/空响应改为显示 `HTTP <status>`，不再把浏览器 JSON 解析异常直接抛到面板底部。
- 已验证设置面板「立即暂停 / 完成当前轮后暂停」切换成功，路由返回 200。

## 0.3.1 — 2026-11-06

- 左侧会话行悬停操作新增盾牌按钮：直接在对话索引里豁免/取消豁免，豁免中的会话行保留盾牌标记。
- 输入框状态条新增「豁免本会话 / 取消豁免」按钮，不用打开设置面板即可切换当前对话。
- 设置面板的会话豁免列表新增搜索过滤，会话多时可按标题或 session id 查找。
- 设置接口的浏览器请求补 `credentials: same-origin`，确保桌面 Web 主机下开关生效。

## 0.3.0 — 2026-11-06

- 新增峰时策略 `pauseMode`：`pause-now` 立即暂停，`finish-turn` 完成当前轮后暂停；设置面板可切换。
- 子代理感知：会话有正在运行的子代理时先放行，子代理结束后再暂停父会话并记录，谷价开始自动恢复。
- 精确模型识别：按 `provider/model` 精确匹配，`peakPricedModels` 精确列表 + `exemptModels` 豁免；设置面板可逐模型开关。
- 新增设置面板（点击左栏计时打开）：峰时策略、模型管理、会话豁免、节假日同步状态。
- 会话豁免：`offpeak_guard exempt/unexempt` 或设置面板，可随时取消。
- 节假日动态识别：默认从公开节假日 API 同步当前/下一年，缓存到 `holidays.json`，失败回退内置 2026 列表；`holidaySource: builtin` 可完全离线。
- 新增环境变量：`DSH_OFFPEAK_PAUSE_MODE`、`DSH_OFFPEAK_HOLIDAY_SOURCE`、`DSH_OFFPEAK_HOLIDAY_API`、`DSH_OFFPEAK_PEAK_MODELS`。
- 状态 schema 扩展：等待中的任务、会话豁免、模型规则、峰时策略；兼容旧 `state.json`。

## 0.2.0 — 2026-11-05

- 默认规则改为 DeepSeek 官方峰谷：工作日 09:00–12:00、14:00–18:00 峰时，周末与**中国法定节假日全天**谷价；内置 2026 年节假日列表。
- 新增 `preset`：`auto` / `deepseek-official` / `workbuddy` / `custom`，按 provider 自动选择（WorkBuddy/CodeBuddy → workbuddy，其余 → 官方）。
- 新增 `Config` schema：DSH 设置页可直接修改时区、窗口、豁免模型、提醒阈值等。
- 新增 `DSH_OFFPEAK_*` 环境变量覆盖（优先级：环境变量 > 配置 > 默认），便于部署方统一注入。
- 状态工具与界面显示当前规则和节假日状态。

## 0.1.0 — 2026-11-05

- 首个公开版本。
- 时间识别：工作日 `09:00–12:00`、`14:00–18:00` 峰时，其余时间谷价 5 折（可配置窗口、星期、时区与折扣）。
- 模型识别：按会话真实请求头判断是否峰谷计价模型，支持逐模型豁免。
- 峰时自动暂停运行中的任务、停住峰时新任务；谷价开始自动恢复被中断的任务（保留待处理队列）。
- 错峰工作规划：`offpeak_plan` 把任务排进下一个谷价窗口，谷价时段自动执行。
- 界面：输入框下方峰谷状态条；左栏底部紧凑计时（临近峰价闪红、临近谷价闪绿），悬浮说明保持稳定不闪。
- 手动控制：`offpeak_guard` 的 `pause_now` / `resume_now` / `run_plans_now`。
