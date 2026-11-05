# 错峰调度 · 峰谷守卫（dsh-offpeak-guard）

在 DeepSeek Harness 里按 **DeepSeek 峰谷计价** 安排工作：

- **时间识别**：工作日 `09:00–12:00`、`14:00–18:00` 为峰值原价；其余时间（含午间、夜间、周末）为谷价，按 5 折计费（默认 `Asia/Shanghai`）。
- **模型识别**：只有使用峰谷计价模型（默认模型名含 `deepseek`，可在 `exemptModels` 里逐项豁免）的会话才会被暂停/恢复；用其它模型的会话不受影响。
- **工作规划**：
  - 峰时开始 → 暂停正在运行的任务（保留待处理队列，不丢消息）；
  - 峰时新起的任务 → 立即停住，不花峰时 token；
  - 谷价开始 → 自动把被打断的任务交还会话继续执行；
  - 另提供 `offpeak_plan` 工具，把「12 点再跑」这类事排进下一个谷价窗口。
- **界面**：输入框下方一条状态条，显示当前峰/谷、距下次切换的倒计时、当前模型，以及暂停/规划数量；左侧栏底部另有一枚常驻计时，临近切换时闪色提醒（峰价快开始闪红、谷价快开始闪绿）。

![输入框下方的峰谷状态条](docs/peak-strip.png)

左栏计时（平时按峰/谷着色）：

![左栏峰谷计时](docs/sidebar-clock.png)

距峰价开始 10 分钟内闪红（示例）：

![左栏峰谷计时闪红](docs/sidebar-clock-blink.png)

## 工具

| 工具 | 用途 |
| --- | --- |
| `offpeak_status` | 当前时段、下次切换、当前模型是否适用、暂停与规划清单 |
| `offpeak_plan` | `add` / `list` / `remove` / `clear` 错峰规划 |
| `offpeak_guard` | `status` / `pause_now` / `resume_now` / `run_plans_now` 手动控制 |

## 配置

`cordis.patch.yml` 里那一行 `offpeak-guard` 的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `timezone` | `Asia/Shanghai` | 计价时区 |
| `peakWeekdays` | `[1,2,3,4,5]` | 峰时适用的星期（0=周日） |
| `peakWindows` | 09:00–12:00、14:00–18:00 | 峰时窗口；官方调价时改这里 |
| `discount` | `0.5` | 谷价折扣，仅用于显示「5 折」 |
| `modelPattern` | `deepseek` | 模型名/供应商名包含它即视为峰谷计价模型 |
| `exemptModels` | `[]` | 逐项豁免的模型 id |
| `pauseRunningOnPeak` | `true` | 峰时开始时暂停正在运行的任务 |
| `deferNewTurnsOnPeak` | `true` | 峰时新起的任务立即停住 |
| `resumeOnOffPeak` | `true` | 谷价开始时自动恢复 |
| `pollSeconds` | `15` | 检查间隔（5–300） |
| `resumeDelaySeconds` | `3` | 谷价开始后等几秒再恢复 |
| `bypassMinutes` | `10` | 手动恢复后的豁免期，避免立刻又被暂停 |
| `alertMinutes` | `10` | 左栏计时在距切换多少分钟内开始闪烁（0 = 不闪） |

## 数据

状态与快照都在 `$DSH_HOME/offpeak-guard/`：

- `state.json`：暂停中的任务、错峰规划、上次时段；
- `status.json`：给输入框状态条读的只读快照（同时镜像到 `~/.dsh/offpeak-guard/status.json`）。

不写用户工作区。

## 恢复是怎么做的

暂停用 `sessionController.cancel`，它只结束当前一轮、保留待处理队列；恢复用 `sessionController.prompt` 向原会话投递一条「继续上次中断处」的指令，冷会话会被自动唤醒。恢复文本会注明中断时间与被暂停的模型，方便对话里追溯。

## 边界

- 只处理有工作目录、非子代理的根会话，避免打断子代理让父会话卡住。
- 插件自身重启时不会主动打断正在跑的任务（避免刚安装就停掉当前对话）；之后进入峰时或新起任务仍按规则处理。
- 手动「立即恢复」会给这些会话 10 分钟豁免，避免峰时刚恢复又被停回去。
