# Off-peak guard (dsh-offpeak-guard)

[![npm](https://img.shields.io/npm/v/dsh-offpeak-guard?color=blue)](https://www.npmjs.com/package/dsh-offpeak-guard)

Published on npm: install it from the DSH Plugins page, or run
`dsh plugin --profile <profile> add dsh-offpeak-guard`.

Schedule work around **DeepSeek peak/off-peak pricing** inside DeepSeek Harness:

- **Time awareness**: per DeepSeek's official pricing, Beijing-time weekdays (excluding Chinese statutory holidays) `09:00–12:00` and `14:00–18:00` are peak; every other hour (weekends, holidays, lunch, night) is off-peak at 50%. Built-in Chinese holidays cover 2026; add later years with `holidays`.
- **Model awareness**: only sessions using a peak-priced model (model name contains `deepseek` by default; exempt models one by one with `exemptModels`) are paused/resumed. Other models are untouched.
- **Work planning**:
  - peak starts → running tasks are paused (the pending inbox is kept, no message is lost);
  - a task started during peak → stopped immediately, no peak-priced tokens spent;
  - off-peak starts → interrupted tasks are handed back to their session automatically;
  - the `offpeak_plan` tool queues "run this at noon" work for the next off-peak window.
- **UI**: a status strip under the composer (state, countdown, model, paused/planned counts), plus a compact clock at the sidebar foot that blinks red before peak starts and green before off-peak starts.

![Status strip under the composer](docs/peak-strip.png)

Sidebar clock, colored by the current window:

![Sidebar clock](docs/sidebar-clock.png)

Red blink within the alert window before peak (sample):

![Sidebar clock blinking red](docs/sidebar-clock-blink.png)

## Tools

| Tool | Purpose |
| --- | --- |
| `offpeak_status` | Current window, next switch, whether the current model is peak-priced, paused/planned lists |
| `offpeak_plan` | `add` / `list` / `remove` / `clear` off-peak plans |
| `offpeak_guard` | `status` / `pause_now` / `resume_now` / `run_plans_now` manual control |

## Configuration

The `offpeak-guard` row's `config` in `cordis.patch.yml`, or the plugin settings form in DSH (a Config schema is declared):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `preset` | `auto` | `auto` picks by provider: WorkBuddy/CodeBuddy → `workbuddy`, otherwise `deepseek-official`; can be pinned to `deepseek-official` / `workbuddy` / `custom` |
| `timezone` | `Asia/Shanghai` | Pricing time zone (DeepSeek bills in Beijing time) |
| `peakWeekdays` | `[1,2,3,4,5]` | Weekdays with peak windows (0 = Sunday); only used by `custom` |
| `peakWindows` | 09:00–12:00, 14:00–18:00 | Peak windows; only used by `custom` |
| `discount` | `0.5` | Off-peak discount, display only; only used by `custom` |
| `holidays` | `[]` | Extra statutory holidays (`YYYY-MM-DD`), appended to the built-in 2026 list for the official/WorkBuddy presets |
| `modelPattern` | `deepseek` | Model/provider name containing it counts as peak-priced |
| `exemptModels` | `[]` | Model ids exempted one by one |
| `pauseRunningOnPeak` | `true` | Pause running tasks when peak starts |
| `deferNewTurnsOnPeak` | `true` | Stop tasks started during peak immediately |
| `resumeOnOffPeak` | `true` | Resume paused tasks when off-peak starts |
| `pollSeconds` | `15` | Check interval (5–300) |
| `resumeDelaySeconds` | `3` | Wait a few seconds after off-peak starts before resuming |
| `bypassMinutes` | `10` | Grace period after a manual resume |
| `alertMinutes` | `10` | Blink the sidebar clock within this many minutes of a switch (0 = never) |

### Environment variables

Deployments can inject settings with environment variables. Priority: **env > config > default**. Invalid values are ignored.

| Variable | Example | Config field |
| --- | --- | --- |
| `DSH_OFFPEAK_ENABLED` | `0` / `1` | `enabled` |
| `DSH_OFFPEAK_PRESET` | `custom` | `preset` |
| `DSH_OFFPEAK_TIMEZONE` | `Asia/Shanghai` | `timezone` |
| `DSH_OFFPEAK_PEAK_WEEKDAYS` | `1,2,3,4,5` | `peakWeekdays` |
| `DSH_OFFPEAK_PEAK_WINDOWS` | `09:00-12:00,14:00-18:00` | `peakWindows` |
| `DSH_OFFPEAK_DISCOUNT` | `0.5` | `discount` |
| `DSH_OFFPEAK_HOLIDAYS` | `2026-10-01,2026-10-02` | `holidays` |
| `DSH_OFFPEAK_MODEL_PATTERN` | `deepseek` | `modelPattern` |
| `DSH_OFFPEAK_EXEMPT_MODELS` | `deepseek-v4-pro,deepseek-flash` | `exemptModels` |
| `DSH_OFFPEAK_PAUSE_RUNNING` | `0` / `1` | `pauseRunningOnPeak` |
| `DSH_OFFPEAK_DEFER_NEW` | `0` / `1` | `deferNewTurnsOnPeak` |
| `DSH_OFFPEAK_RESUME` | `0` / `1` | `resumeOnOffPeak` |
| `DSH_OFFPEAK_POLL_SECONDS` | `15` | `pollSeconds` |
| `DSH_OFFPEAK_RESUME_DELAY_SECONDS` | `3` | `resumeDelaySeconds` |
| `DSH_OFFPEAK_BYPASS_MINUTES` | `10` | `bypassMinutes` |
| `DSH_OFFPEAK_ALERT_MINUTES` | `10` | `alertMinutes` |

### Presets

- `deepseek-official` (default): official weekday peak windows plus built-in 2026 Chinese holidays (holidays are off-peak all day).
- `workbuddy`: same peak windows, labeled as WorkBuddy credit pricing; selected automatically for WorkBuddy/CodeBuddy providers.
- `custom`: use `peakWeekdays` / `peakWindows` / `discount` / `holidays` exactly, for other providers or self-hosted pricing.


## Data

State and snapshots live in `$DSH_HOME/offpeak-guard/`:

- `state.json`: paused tasks, off-peak plans, last phase;
- `status.json`: read-only snapshot for the UI (mirrored to `~/.dsh/offpeak-guard/status.json`).

Nothing is written into user workspaces.

## How resuming works

Pause uses `sessionController.cancel`, which ends only the current turn and keeps the pending inbox. Resume uses `sessionController.prompt` to deliver a "continue where you left off" instruction to the original session; cold sessions are woken automatically. The resume text mentions the interruption time and the paused model so it stays traceable in the conversation.

## Boundaries

- Built-in statutory holidays cover 2026 only; after the 2027 schedule is published, upgrade the plugin or append dates with `holidays` / `DSH_OFFPEAK_HOLIDAYS`, otherwise holidays are treated as ordinary weekdays.
- Named presets have fixed windows; use `preset: custom` for other providers or self-hosted pricing.
- Only root sessions with a working directory are handled; subagent sessions are skipped so parents do not hang.
- A plugin restart does not cancel tasks that are already running (so installing the plugin cannot kill the current conversation); the next peak or new task follows the rules again.
- Manual `resume_now` grants those sessions a 10-minute grace period so they are not paused again immediately.
