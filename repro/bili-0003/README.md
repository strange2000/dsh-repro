# bili-0003：桌面版装完直接用不了的三处 bug

> [English](README.en.md) · 中文

对应上游项目：[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，
完整报告在 [`../../reports/0003-dsh-bili-scroll.md`](../../reports/0003-dsh-bili-scroll.md)。

三处 bug 各自独立，但都挡在「第一次能用」之前：

| # | 症状 | 根因一句话 |
|---|---|---|
| 1 | 点「扫码登录」没反应，不出二维码 | `pythonPath` 被宿主那份启动快照压回 `"python"` ⇒ spawn 到微软商店存根（exit 9009），而画二维码的失败被静默吞掉 |
| 2 | 改一个开关，另一个跟着变 | `saveCfg()` 把**整份内存 cfg** 写回磁盘 ⇒ 陈旧键连带落盘 |
| 3 | 「跑一轮」必失败 | 桌面版 CLI 只在 `app.asar` 里（三条硬编码候选全落空）+ headless overlay 把 `credentials` 等三个服务关了 |

## 用法（只读）

```bash
node audit-config.cjs                    # 插件 / 状态目录 / profile patch 都按默认位置找
node audit-config.cjs --plugin <插件目录>
node audit-config.cjs --state <状态目录>   # 默认 ~/.dsh/bili-duty
node audit-config.cjs --patch <cordis.patch.yml>
node audit-config.cjs --json
node audit-config.cjs --selftest         # 先验证判定器本身可信（离线）
```

不启动插件、不跑一轮、不改任何配置。只读源码 + 只读三份状态文件 + 只读探路（文件在不在）。

## 四段输出

**一、源码**：每条 bug 对应一个可判定的代码路径

| 项 | 判定依据 | 缺陷 | 修好 |
|---|---|---|---|
| B1 | `loadCfg()` 的宿主基准 | `const out = { ...hostCfg() }`（apply 时的快照） | `normalize(row.value … )`（设置行现值） |
| B1b | `pythonPath` 是否本地优先 / 有 venv 兜底 | 都没写 ⇒ 宿主那份 `"python"` 赢 | 在「本地优先」名单里，或 `venvGuess` 兜底 |
| B2 | `saveCfg()` 是否整份写回 | `writeJson(cfgFile, cfg)`，无来源标记 | 只写 patch / 带 `_set` 来源标记 |
| B3 | 找 dsh 的策略 | 三条硬编码（`app.asar.unpacked` / `app` / `node_modules`） | 解析器 + npm 全局 + 应用目录有界递归 |
| B4 | overlay 是否重开三服务 | `credentials`/`authorization`/`deepseek-account` 仍 `disabled: true` | 三条都写 `disabled: false` |

`·` 表示仅供参照、不参与结论（比如 B2 的 `_set`：它不是根治，但确实挡住了「陈旧键被写回又被读回」这一环）。

**二、现场三方对照**：`config.json` / 宿主 `cordis.patch.yml` / `local-override.json` 的同一批键摆在一起，直接看「改一个冲掉一片」有没有在复发。`local-override.json` 里有键，就说明那一次 `settings.update` 没写进宿主（桌面版 profile reload 限制的残留）。

**三、pythonPath 探路**：`config.json` 里的值、venv 实际路径、以及会不会 spawn 到 `"python"`。

**四、自己核的办法**：`grep -n "spawn → python" duty.log`、设置页「自检」那行的 `resolveDsh()` 返回。

## 实测（2026-11，本机 Windows 11 + DSH NEXT 桌面版）

```
插件版本：2.5.0
  ✅ [B1]  基准改成 row.value
  ✅ [B1b] pythonPath 在「本地优先」名单里
  · [B2]   仍写整份 cfg，但带 _set 来源标记（部分缓解，不是根治）
  ✅ [B3]  解析器 + npm 全局 + 应用目录有界递归
  ✅ [B4]  三个 id 都写了 disabled: false
  小计：4/4 项通过 → FIXED

三、pythonPath：…\bili-duty\.venv\Scripts\python.exe（存在）→ OK
二、三方对照：perDay / peakValley / autoComment / dmMode / pythonPath / workspace / replyToComments 全一致
```

即：三处 bug 在本机 2.5.0 上都已修掉，唯一留着的尾巴是 B2 的「整份写回」——被 `_set` 与 `local-override.json` 两层挡住，但写路径本身没改成「只写 patch」。

顺带一条对上游仍然成立的事实：报 issue 那次是**通过插件市场**装的，拿到的是 `0.1.7`，而当时 GitHub main 已经 `0.1.10` —— 也就是说「从市场装的人」会稳定命中已经修好的 bug。这类「发布的版本落后于源码」的问题比 bug 本身更伤，复现材料的价值就在于能把两件事分开讲清楚。
