# chorography T1 审计器 · `locateCliJs()` 的 asar 路径

> [English](README.en.md) · 中文

对应上游 [slow-stack/mneme#578](https://github.com/slow-stack/mneme/issues/578)：0.11.0 的 chorography T1 headless runner 用一条**硬编码**路径拼出 CLI 入口，在 DSH NEXT 桌面版上整体不可用 —— 现场只报 `headless 退出码 1：(无输出)`。

一句话说清这条缺陷为什么难查：

> 它没有栈。`spawn` 出去的进程拿着一份不存在的入口，还没跑到能打栈的地方就退出了；chorography 把 stderr 收进结果对象，于是「无输出」被当成「跑挂了但没有原因」。

```bash
node audit-t1-locate.cjs                                  # 自动找 mneme + 自动找安装目录
node audit-t1-locate.cjs --exe "D:/DSH NEXT/DSH NEXT.exe"
node audit-t1-locate.cjs --asar "D:/DSH NEXT/resources/app.asar"
node audit-t1-locate.cjs --json
node audit-t1-locate.cjs --selftest
```

零依赖、只读：源码 `readFileSync`，`app.asar` 只用**文件头**解析目录索引（不展开、不提取、不写盘），不 spawn 宿主。退出码 `0` = 审计跑完、`1` = 自检没通过、`2` = 参数或环境错误。

## 它判什么

| 项 | 判据 | 权重 |
|---|---|---|
| **A** CLI 定位函数（`locateCliJs`，改名后为 `resolveCliJs`）有候选路径 / 探测回退 | 函数体里有候选数组、循环试路径、或提到真入口 `desktop-cli`；函数**按候选名单找**，不只认一个名字 | 结论项 |
| **B** 能读 asar 内部 | `original-fs` / `@electron/asar` / `extractFile` | 参照项 |
| **C** 定位失败会 `return null` | 触发 `kind: "environment"` 降级，而不是把错路径交出去 | 参照项（A 的补充证据） |
| **D** `locateDshExe` 认得 DSH NEXT 的 exe 名/位置 | 只认 `deepseek harness.exe` + `Program Files\DeepSeek Harness` ⇒ 不认；出现 `DSH NEXT` 目录名或 `DSH_EXE` 覆盖也算认得 | 结论项 |
| **实测** 硬编码路径在真安装里存不存在 | 零依赖解 asar 头，逐段查 `files` | 结论项（决定 DEFECT） |

结论四档：`FIXED`（源码已是候选/探测形状）· `DEFECT`（硬编码且实测路径不存在）· `SUSPECT`（路径恰好存在、或没找到安装目录无法验证、或源码判定不出）—— 都带一句为什么。`SUSPECT` 还包括「按 `locateCliJs` / `resolveCliJs` / `resolveCliPath` 三个名字都抠不到函数体」：上游改名会落进这一档，所以判定器改成按候选名单找函数。

## 本机实测（2026-11-08，mneme `0.12.0`，DSH NEXT 桌面版）

```
源码侧   A MISS   B 没有   C 不会   D MISS
实测侧   安装 D:\DSH NEXT\resources\app.asar
         asar 顶层：node_modules assets build cordis.patch.yml
                    desktop-runtime.json host.cordis.patch.yml lib package.json scripts
         硬编码路径 dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js → 不存在
         真入口候选 lib/desktop-cli.js · lib/main.js
         @deepseek-ai 包数 340，其中 dsh-desktop-host 不存在

结论 DEFECT
```

### 2026-11-14 复测（mneme `0.15.1`）→ `FIXED`

上游在 #618 里把它修了，函数也改名为 `resolveCliJs`：候选数组按优先级排 `DSH_CLI_JS` → `<asar>/lib/desktop-cli.js` → 旧布局两条，逐个 `existsSync` 探测，命中返回 `{ path, candidates, verified: true }`；`DSH_CLI_JS` 是「人明确指定」的答案，指定了就不再猜，不存在则直接失败并如实指出那个路径。`locateDshExe` 一并改成 `["DeepSeek Harness", "DSH NEXT"]` 两种布局 × 两种名字，并支持 `DSH_EXE`。

```
源码侧   A ok（resolveCliJs）   B 没有   C 不会   D ok（另认 DSH_EXE 覆盖）
结论 FIXED
```

**这条判定器也误判过一次**：它按 `locateCliJs` 一个名字抠函数体，上游改名后抠不到，于是把「已修好」判成 `SUSPECT`。现在按候选名单找，并在 A 项里打出实际命中的函数名。

三件值得单独说的：

1. **问题比 issue 里写的更深一层。** 原报告说「硬编码 `app.asar.unpacked` / `app` / `node_modules` 三个位置」，实测发现 DSH NEXT 的 asar 里**根本没有 `dsh/` 这个顶层目录**，而且 `@deepseek-ai` 下 340 个包里**没有 `dsh-desktop-host`** —— 不是「路径前缀写错了」，是这个包在 DSH NEXT 里不存在。拼接再多几个前缀也拼不出来。
2. **真入口就在旁边。** `app.asar/lib/desktop-cli.js` 一直都在，`--expose-internals <asar 内路径> --profile … --json headless <task>` 这套调用姿势不变，只是喂给它的第一个参数要换成这个。
3. **`locateDshExe` 同样只认「DeepSeek Harness」。** DSH NEXT 的主程序叫 `DSH NEXT.exe`、装在 `D:\DSH NEXT\`，`Program Files\DeepSeek Harness\DeepSeek Harness.exe` 这个回退位在本机不存在。所以即使 CLI 路径修好了，exe 这一层还需要 `DSH_EXE` 环境变量兜底 —— 这就是为什么 issue 里那句「设 DSH_EXE」是必要条件而不是可选项。

## 最小修法（三个角色都写清楚）

- **`locateCliJs`**：不要拼一条路径，给候选集合并逐个探测 —— 至少 `lib/desktop-cli.js`、`dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 两种布局，用 `existsSync`（普通文件系统语义即可，asar 内路径在 Electron 的 fs 下能 stat 到；纯 node 子进程里不能，所以探测要在**父进程**做）。全都不命中就 `return null`，让它走 `kind: "environment"` 的降级分支，把「找不到 CLI 入口」这行原因交给上层 —— 现在的行为是把一条错路径交出去，等于把可诊断的错误变成了「无输出」。
- **`locateDshExe`**：把 exe 名做候选（`DSH NEXT.exe` / `DeepSeek Harness.exe`），并且在失败信息里**列出试过的位置**，而不是只说「找不到」。
- **调用方（chorography 编排层）**：`environment` 失败要能透传 `reason` 到报告里。当前占位段 `stubReportIfMissing(code)` 会把真实原因盖掉，这也是「无输出」的另一半原因。

## 自检

`--selftest` 用两段合成源码（缺陷形硬编码 / 修好形候选探测）+ 一段 `locateDshExe`，再对合成的 asar 索引验 `asarHas` / `asarList`；如果本机有真 asar，顺手验一次解析器（只做旁证，不计入通过数）。当前 **7/7 通过**。

这个仓库里的四个审计器，判定器 bug 全是首跑自检抓出来的 —— 自检不是形式主义，它是唯一能在「结果看起来很像正确答案」时救你的东西。
