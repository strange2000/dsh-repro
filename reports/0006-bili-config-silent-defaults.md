# 存下去了，但没生效：三个各自正确的「静默降级」

<!-- tl;dr-en -->
> **TL;DR (English)** Three separate issues in one plugin, filed weeks apart, turn out to share one shape: a component cannot read, cannot write, or cannot count — and in every case it **silently substitutes a default for the truth**. (#78) `parseSeenTable()` accepted table rows only, so a `seen.md` written in any other layout was unreadable: not one of 100+ records parsed, the "videos it has scrolled" panel stayed empty, no error. (#79) `POST /api/bili-duty/config` rebuilt the patch from a hand-written 1.x allowlist, so 2.x fields (`dmWatch` / `favFolderId` / `personaPrompt`) were dropped on save, and the panel's 5-second poll flipped the toggle back; the same save also carried `{"keywords":[]}`, wiping the user's keyword list. (#80) With `reportLevel=off` there is no report file to count, so `countPickedToday()` returned 0 forever, the `perDay` gate never fired, and a limit of 5 produced 10 picks in a day while the panel still showed 0. Diagnostic proof for #79 was differential: the MCP `bili_config` tool bypassed the whitelist, so on the same machine the tool could write and the panel could not. All three are fixed as of 2.5.0 (auditor verdict FIXED, 7/7 decisive items); the residual is that `saveCfg()` still writes the whole in-memory object, which `_set` and `local-override.json` intercept but do not remove.

对应上游三条 issue：[#78](https://github.com/c1overzz/dsh-bili-scroll/issues/78)（判重表读不出来）、[#79](https://github.com/c1overzz/dsh-bili-scroll/issues/79)（面板存了等于没存）、[#80](https://github.com/c1overzz/dsh-bili-scroll/issues/80)（上限失效）。它们分别发生在**读**、**写**、**判**三个位置，报的时间也隔了几周。写在一份报告里，是因为翻源码时发现三者是同一个动作：

> 读不到 → 当作没有；写不进 → 当作没改；数不到 → 当作 0。

每一步都「按自己的逻辑正确」，每一步都不报错。合起来，用户看到的就是「我改了，它不认」以及「它说没挑，其实挑了一整天」。

## 现象

| issue | 用户看到 | 实际上发生 |
|---|---|---|
| #78 | 面板上「它刷过的视频」永远是空的 | `parseSeenTable()` 假设 `seen.md` 是固定列位的表格；章程从没规定过写法，用户那份一百多条记录一条也没进来 |
| #79 | 设置页改完，五秒后自己变回去；关键词偶发清空 | `POST /config` 用 1.x 时代的白名单重建 patch，2.0 新增字段（`dmWatch` / `favFolderId` / `personaPrompt`）在入口就被过滤；同一次保存还附带 `{"keywords":[]}` |
| #80 | 上限设 5，一天挑到 10 条；面板 `pickedToday` 显示 0 | 「不写日报」档没有报告文件可数 ⇒ `countPickedToday()` 恒 0 ⇒ `perDay` 闸门永不成立；保底只约束定时窗口，`runDuty('manual')` 不受约束 |

三条的共同点还是那句：**没有报错**。没有异常、没有栈、没有警告，只有「界面上的数字不对」——而数字不对最容易先被归因成「我记错了」。

## 判据：一个审计器，三个结论项

`repro/bili-0003/audit-config.cjs` 原本只判 0003 的三处（装完直接用不了），T14 扩到能判这三条。结论项决定结论，参照项只作旁证。

| 项 | 判什么 | 缺陷形 | 修好形 |
|---|---|---|---|
| **B5** | 判重表怎么解析（#78） | 假设 BV 固定在某个列位、日期照一种格式硬解，坏行静默丢 | BV 用 `findIndex` 扫描定位，日期走 `seenDay()` 宽松解析，坏行计数并在数量变化时 `log` |
| **B6** | 配置写入通道的白名单（#79） | 手写 `ALLOW` 数组 ⇒ 新增字段被静默过滤 | 从 `Object.keys(DEFAULTS)` 推导；另带空值保护（空值不覆盖已有值，清空要显式 `clear`） |
| **B7** | `reportLevel=off` 时数什么（#80） | 只数报告文件 ⇒ 恒 0 | 退一步去 `seen.md` 数「当天 + 已挑中」的行 |
| **B7b** | 手动轮是否单独记账（参照项） | 手动轮挑的挤占当天自动额度 | `manualExtra` 单列，`autoPickedToday()` 扣掉它 |

`--selftest` 现在是 **18 条逐项断言**：缺陷形每条必须判 false、修好形每条必须判 true。扩项那次首跑失败 5 项，抓出判定器自己的三个 bug（参数表里带括号的函数签名抠不出来、B6 的正则误蹭了别处的 `Object.keys(DEFAULTS)`、以及把参照项 B2 当成结论项断言）。**尺子先坏过一次，结论才可信。**

## 本机实测（2026-11-08，`dsh-bili-scroll` 2.5.0，Windows 11 + DSH NEXT 桌面版）

```
✅ [B1] 基准改成 row.value          ✅ [B5] BV findIndex + seenDay + 坏行计数
✅ [B1b] pythonPath 本地优先         ✅ [B6] 白名单从 DEFAULTS 推导 + 空值保护
· [B2]  仍整份写回，带 _set 标记     ✅ [B7] 不写日报时回退数 seen.md
✅ [B3] 解析器 + 有界递归            · [B7b] 有 manualExtra
✅ [B4] 三服务 disabled: false
小计：7/7 项通过 → FIXED
```

三方配置对照（插件 `config.json` / 宿主 `cordis.patch.yml` / `local-override.json`）七个键全部一致：`perDay` / `peakValley` / `autoComment` / `dmMode` / `pythonPath` / `workspace` / `replyToComments`。`config.json` 里 `_set` 记了 16 个「插件面板说了算」的键。

但有一条**要留着当证据看**：`local-override.json` 里仍有 8 个键（`keywords`、`dmWatch`、`dmWatchMinutes`、`dmOwnerUid`、`dmMode`、`personaPrompt`、`peakValley`、`mentionName`）。这份文件的存在本身就是判据 —— 里面有键，说明那一次 `settings.update` 没写进宿主（桌面版 profile reload 的限制），插件只能先记在本地。

## 修法：把「静默」改掉，而不是把默认值改对

三处都不是「算错了」，是**错了不吭声**。所以修法的重点不在补分支，在于让每一层能说出自己丢掉了什么。

**读侧（#78）**：解析器要能吃不规则的输入，同时**坏行必须计数并上报**。第一版「遇到不认识的行就 `continue`」正是问题本身；现在的形态是允许读不出来，但不允许不知道。

**写侧（#79）**：白名单必须从**单一真相**推导（`DEFAULTS` 就是那份名单），而不是再维护一份镜像。空值要单独处理：`""` 和「没填」是两件事，清空必须是显式动作（`clear: [...]`）。写入后要能报告「哪几个键宿主没接」—— `local-override.json` 就是这个报告。

**判侧（#80）**：任何「计数」都要有兜底来源，并且要能区分「真的是 0」和「我读不到」。`0` 是最危险的一个默认值：它同时表示「没有发生」和「我不知道」。

**顺带一条给宿主层的**：`local-override.json` 这类「本地暂存、宿主没接」的状态，应该有用户可见的提示。它现在是一个只有作者知道含义的文件 —— 排查时是线索，日常里是沉默。

## 局限

- 审计器**判形状不判语义**：它确认「BV 是扫描定位的」「白名单是从 DEFAULTS 推导的」，不能证明某个具体 `seen.md` 一定解析正确。要验语义得跑真实数据，那是另一件事。
- **`·` 的那两项不是修好了**：B2 仍整份写回（`_set` 只挡「陈旧键被写回又被读回」这一环），B7b 只是记账方式变了。这类「部分缓解」在索引里标 `·`，不算通过。
- 本机 2.5.0 已修，这些审计器的长期价值是**回滚检测**：插件降级、或换一台还在旧版本的机器时，一条命令就能说出「哪一条回来了」。
- 报 issue 那次是从插件市场装的 `0.1.7`，而当时 GitHub main 已在 `0.1.10`。**「市场版本落后于源码」比 bug 本身更伤** —— 用户会稳定命中已经修好的问题，然后把「已修」读成「没修」。
