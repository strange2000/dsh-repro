# 「重启后皮肤都没了」：一次没有重试的加载，把用户的选择换成了默认

> [English](0007-skin-center-coldstart-fallback.en.md) · 中文

<!-- tl;dr-en -->
> **TL;DR (English)** The complaint is "every restart puts my skin back to the official default", and the first instinct — the setting was not saved — is wrong. `~/.dsh/skin-center-active.json` still held `{"active":"tight-sidebar"}`, `GET /api/skin-center/v2/active` still answered `tight-sidebar`, and the skin files were intact. What fails is the cold-start load: skin CSS must pass a lightningcss whitelist transform that forks a short-lived worker per request under a 10 s budget (`lib/index.js:1824`, `:1892`); the first request after mount measured **14.59 s**, so `serveStylesheet()` answered HTTP 500 `css-transform-failed`, and `bootSkinRuntime()`'s catch does a single `adopt(null, null)` with no retry (`lib/client.js:1768-1770`) → `removeAttribute('data-dsh-skin')` (`:1524-1538`) → official default. It hit 9 of 9 cold starts across five days (11-16 → 11-23) and 0 times when switching skins without restarting. Verdict on 0.4.21: **DEFECT**. Reported as zhu1090093659/dsh-web#2085; the auditor here re-asks "would my copy still do this?" in one command.

对应上游 issue：**[zhu1090093659/dsh-web#2085](https://github.com/zhu1090093659/dsh-web/issues/2085)**（插件真身在 [zhu1090093659/dsh-skins](https://github.com/zhu1090093659/dsh-skins) 的 `packages/skins/skin-center`，`@linxin666/dsh-client-ui-skin-center` 0.4.21）。

## 说得再直白一点

用户的体感是：「每次重启 DSH，皮肤都被改回默认，我自己设置的那个失效了。」

这句话里有一个容易顺着走的假设：**设置没存住**。实测不是。选择一次都没丢，丢的是**冷启动的那一次加载**：

皮肤 CSS 不直接下发，要先过一遍 CSS 安全管线（lightningcss 白名单转换），**每个请求 fork 一个短命 worker 进程**，预算 **10 s**。冷启动后第一次请求实测 **14.59 s** ⇒ 超预算 ⇒ `500 css-transform-failed`；渲染端 `bootSkinRuntime()` 的 catch **只做一次** `adopt(null, null)`，没有重试 ⇒ `removeAttribute('data-dsh-skin')` ⇒ 官方默认。

于是同一份「没变过的选择」，在第二次（热）加载时能正常应用，在第一次（冷）加载时被丢掉。

## 为什么不是「设置被重置」

| 证据 | 实测结果 |
|---|---|
| `~/.dsh/skin-center-active.json`（238 B） | `{"active":"tight-sidebar","initialized":true,...}` —— 选择在 |
| `GET /api/skin-center/v2/active`（失败当时，进程内） | 返回 `tight-sidebar` |
| `GET /api/skin-center/v2/catalog` | 200 |
| `~/.dsh/skins/tight-sidebar/` | `skin.css` + 16 KB `patches.css` 完好 |
| 宿主日志 | 每次冷启动都有同一条 `stylesheet load failed` |

持久化 / 路由 / 磁盘 / 皮肤目录四样都正常，问题只剩一处：**渲染端在一次失败的加载之后直接放弃了**。

## 现场

宿主日志 `~/.dsh/logs/desktop-next-<日期>.0.jsonl`，每次冷启动同一条：

```
[skin-center] switch to tight-sidebar failed; previous skin intact
Error: stylesheet load failed: api/skin-center/v2/skins/tight-sidebar/stylesheet
```

统计：**9 次失败 / 5 个日期**（11-16 ×1、11-17 ×2、11-18 ×1、11-20 ×4、11-23 ×1），覆盖本机 6 个日志文件里的每一次冷启动 —— 不是偶发。

单次时间线（11-23，`runId abc8cb61-…`，`seq 92`）：

| 时刻 | 事件 |
|---|---|
| 06:51:51 | 进程启动 |
| 06:52:10–19 | 插件挂载 |
| 06:52:38 | web 就绪 |
| 06:52:42 | Host ready |
| 06:52:56 | renderer 启动 |
| 06:53:10 | 内核二次 apply（`patch: entry ... not found`） |
| 06:53:12 | 样式表请求失败 |

失败发生在启动后约 80 s —— 不是首帧时序，也不是用户操作触发，而是**启动路径上那唯一一次尝试**。

## 对照实验：同进程 0 次失败，只有冷启动失败

对同一个进程（`127.0.0.1:48611`）在插件刚挂载后连续打点：

| 请求 | 第 1 次 | 第 2 次 | 第 3 次 | 第 4 次 |
|---|---|---|---|---|
| `GET …/skins/tight-sidebar/patches` | **14.59 s** | 0.331 s | 1.382 s | 0.644 s |
| `GET …/skins/tight-sidebar/stylesheet` | 0.764 s | 0.315 s | 1.825 s | — |

三个推论：

1. **14.59 s vs 10 s 预算** —— 首请求是被预算打断的，不是被白名单拒绝的（后者会返回 422 `css-whitelist-violation`，而日志里是 500）。
2. **热了之后全部 < 2 s** —— 差的不是 CSS 复杂度，是 worker 的冷启动成本（每请求 fork 一个短命进程）。
3. **不重启反复切换皮肤 0 次失败** —— 所以这不是「皮肤文件坏了」，而是「启动时只有一次机会」。

## 判定：一条命令

```bash
node repro/skins-coldstart/audit-coldstart.cjs            # 自动扫 ~/.dsh/profiles/<profile>/node_modules/@linxin666/dsh-client-ui-skin-center
node repro/skins-coldstart/audit-coldstart.cjs --selftest # 先证明判定器分得开缺陷形状与修复形状（离线）
```

| 项 | 查什么 | 修好的样子 |
|---|---|---|
| **A（结论项）** | 落默认的 `adopt(null, null)` 之前 600 字符内有没有循环 / 退避 / 重试 | 有 —— 例如 1 s / 3 s / 6 s 三次退避后仍失败才落默认 |
| **B（结论项）** | `SKIN_CSS_REQUEST_TIMEOUT_MS` 是否放宽（≥ 30 s）或存在 worker 预热 | 放宽或预热 —— 冷启动首请求不再被预算打断 |
| C（参照项） | 宿主日志里的 `stylesheet load failed` 计数与日期 | 新版本上不再新增（读的是历史日志，单看会误判） |
| D（参照项） | `skin-center-active.json` 里 `active` 是否非空 | 非空 —— 佐证「选择没丢，是运行期拉取失败」 |

结论三档：`FIXED`（A 成立）/ `PARTIAL`（只放宽预算或预热，一次性失败仍会落默认）/ `DEFECT`（两者都没有）。

**`--selftest` 不是装饰**：它把「缺陷形状」和「修复形状」的合成 `bootSkinRuntime`、两种预算常量、一条合成日志行喂给同一批判定函数，要求分别判出「无重试 / 有重试」「10000 / 30000」「计到 1 行」。尺子分不开，真机结论就没意义。

## 实测（2026-11-23，本机 Windows 11 + DSH NEXT 0.4.21）

```
皮肤中心冷启动回退 · 只读审计

插件目录：~/.dsh/profiles/<profile>/node_modules\@linxin666\dsh-client-ui-skin-center
版本：0.4.21
  ❌ [A] 落默认前无循环/退避/重试：一次性 adopt 失败即清皮肤
  ❌ [B] 预算仍是 10000ms（冷启动首请求实测 14.59s 打不住）
  结论：DEFECT

宿主日志：~/.dsh/logs（6 个 .jsonl）
  ❌ [C] stylesheet load failed ×9，switch failed ×9，日期：2026-11-16 / 2026-11-17 / 2026-11-18 / 2026-11-20 / 2026-11-23
  ❌ [D] active=null（initialized=true）

说明：[C] 是参照项（读的是历史日志），结论只由 [A] 决定、[B] 判断是否被绕开。
脚本不改任何文件、不改配置；--probe 是唯一会联网的选项，且只打本机 GUI。
（上面的路径已把本机用户名隐去、归一化成 `~/.dsh` 与 `<profile>`，其余逐字保留。）
```

`[D]` 显示 `active=null` 是因为**写这份材料时用户已经手动切回官方默认**（为了截官方默认外观的图），不是失败的一部分；失败当时的 `active` 与 `GET /active` 都是 `tight-sidebar`，见上面「为什么不是设置被重置」那张表。

## 代码位置

主干（zhu1090093659/dsh-skins）：

- `packages/skins/skin-center/src/client/runtime/boot.ts:234-238` —— 启动 `adopt` 的 catch 只做一次 `adopt(null, null).catch(() => {})`

0.4.21 安装包编译产物（`@linxin666/dsh-client-ui-skin-center`）：

- `lib/client.js:1684-1771` `bootSkinRuntime()`：`refreshCatalog()` → `GET /active` → `controller.adopt()`；`:1768-1770` catch 只 `await controller.adopt(null, null)`
- `lib/client.js:1524-1538`：`currentActivation === null`（冷启动必然）→ `removeAttribute('data-dsh-skin')`
- `lib/index.js:1822` `SKIN_CSS_MAX_OUTSTANDING = 8`、`:1824` `SKIN_CSS_REQUEST_TIMEOUT_MS = 1e4`、`:1892` `this.timeoutMs = options.timeoutMs ?? 1e4`
- `lib/index.js:2697-2736` `serveStylesheet()`：`SkinCssSafetyError` → 422；`Overloaded` → 503；其余（含 `SkinCssTransformTimeoutError: skin CSS safety transform timed out after 10000ms`）→ 500
- `lib/index.js:3765-3768` config schema 只有 `skin-background` / `skin-custom-theme`，没有任何超时或重试开关

## 最小修法

1. **治本**：`boot.ts` 的 catch 加重试 —— 1 s / 3 s / 6 s 各一次，仍失败才落默认（复用同一个 controller，不要新建）。
2. **治标但便宜**：`SKIN_CSS_REQUEST_TIMEOUT_MS` 从 `1e4` 放宽到 `3e4`–`6e4`，或在插件挂载后预热一次 CSS 转换 worker（首请求实测 14.59 s，热了之后 < 1.4 s）。
3. **用户侧临时规避**：重启后在皮肤中心再点一次「使用」，或刷新一次 web 页面。选择一直在，重新应用即可。

## 状态

- 上游 issue [#2085](https://github.com/zhu1090093659/dsh-web/issues/2085)：open。
- 本机 0.4.21：**DEFECT**（A 无重试、B 预算未放宽）。
- 材料留着的用处是**回滚检测**：插件降级、或换一台还在旧版本的机器，跑一次审计器就知道「这一条回来了没有」。
