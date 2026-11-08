# 两个不报错的缺陷：一个悄悄长大，一个把原因吞掉

> [English](0005-mneme-silent-failures.en.md) · 中文

<!-- tl;dr-en -->
> **TL;DR (English)** Two mneme defects that never throw: (1) `dream_runs` has no `DELETE` path and no retention key applies to it — on this machine 92 rows hold 36.2% of the database pages (21.95 MB of 60.6 MB, `input` 12.21 MB, ~136 KB per row); 0.12.0 added an `input`-only trim, so the verdict is PARTIAL, not FIXED. (2) `locateCliJs()` hardcodes `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`, but DSH NEXT's asar has no top-level `dsh/` and no `dsh-desktop-host` package at all among its 340 `@deepseek-ai` packages; the real entry is `app.asar/lib/desktop-cli.js`. The child therefore dies before it can print a stack, which is why the only symptom is `headless exit code 1: (no output)`. Both are judged by read-only auditors, and both verdicts were produced by scripts that self-check first.

对应上游两条 issue：[#557](https://github.com/slow-stack/mneme/issues/557)（`dream_runs` 无界增长）和 [#578](https://github.com/slow-stack/mneme/issues/578)（chorography T1 在 DSH NEXT 上整体不可用）。它们表面无关，写在一起是因为**同一个性质**：

> 都不抛错。一个让库慢慢变大，一个把失败原因吞成「无输出」。等你发现时，第一件事都是「先证明它真的在发生」——而这恰恰是最花时间的一步。

## 现象

**#557** 不报错，只表现为体感变慢：备份变慢、快照变大、迁移超时。没有任何一条日志指向 `dream_runs`。

**#578** 只有一行字：

```
headless 退出码 1：(无输出)
```

没有栈、没有 stderr、没有「找不到模块」。因为子进程拿到的是**一条不存在的入口路径**，它在能抛异常之前就退出了；而这行 stderr 又被收进结果对象，`stubReportIfMissing(code)` 再用占位段落把它盖住。

两条的现场都指向同一个教训：**「没有报错」不等于「没有发生」**，而「有输出」也不等于「输出的是原因」。

## 判据：两个审计器各自的结论项

只读、零依赖、不加载插件、不写盘。判定项故意分成两类 —— **结论项**决定结论，**参照项只作旁证**（单独看会误判已修版本）。

| 审计器 | 结论项 | 参照项 |
|---|---|---|
| `repro/mneme-retention/`（#557） | A `dream_runs` 有无 `DELETE` 路径；B 有保留期键落到它；C 有无「只清 `input` 列」的裁剪（决定 PARTIAL） | D 实测行数 / 占库页比 / 字节 / 跨度 |
| `repro/mneme-chorography/`（#578） | A `locateCliJs` 有候选/探测；D `locateDshExe` 认得 DSH NEXT 的 exe；实测硬编码路径在真安装里存不存在 | B 能否读 asar 内部；C 定位失败是否 `return null` |

两个脚本都带 `--selftest`：合成源码的形状（缺陷形 / 部分缓解形 / 修好形）喂同一判定函数，**先验尺子，再看结论**。这不是仪式 —— 本仓库四个审计器的判定器 bug 全部是首跑自检抓出来的，而且每一个错起来都特别像正确答案。

## 本机实测（2026-11-08，mneme `0.12.0`，DSH NEXT 桌面版）

**#557 — 结论 `PARTIAL`**

```
库 60.6 MB · page 4096 × 15515 · freelist 0
dream_runs 92 行 → 21.95 MB → 36.2% 的页
input 列 12.21 MB（92 行有值，平均 136 KB/行）
跨度 2026-10-14 → 2026-10-18，全部 run_type=auto

保留期键 4 个 → 清理函数 3 个 → 目标表：
  recallRetentionDays            → purgeRecallRunsOlderThan → recall_runs
  reflectionFailureRetentionDays → deleteOldFailures       → failure_memories
  llmAudit.retentionDays         → deleteOldLlmAudits      → llm_audit_logs
  distillRecords.retentionDays   → clearDreamRunInputs     → dream_runs(**只清 input 列**)
```

三件必须说清的事：

1. **行数极少、体积极大。** 92 行吃掉 36.2% 的页。任何「按行数设阈值」的清理策略在这张表上永远不触发 —— 这是它被漏掉的原因，也是为什么必须在审计器里报**占库页比**而不是行数。
2. **issue 里写 43%，现在 36.2%。** 同一个病灶，涨得慢了些。这类比例不能当「已修复」的证据。
3. **0.12.0 加了部分缓解，所以判 PARTIAL。** `clearDreamRunInputs(before)` 只把旧行的 `input` 置空（`run_type != 'organize'`），行本身、`decisions`、`outcome` 永久保留。**只治最肥的那一列，不是治这张表。**

补一条容易误读的：删行不会归还文件页，SQLite 要 `VACUUM` 才缩文件。本机 `freelist 0`，说明此刻没有待回收空页 —— 于是「清了但库没变小」会是预期现象，不是清理没生效。

**#578 — 结论 `DEFECT`**

```
asar 顶层：node_modules assets build cordis.patch.yml
           desktop-runtime.json host.cordis.patch.yml lib package.json scripts
硬编码路径 dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js → 不存在
真入口候选 lib/desktop-cli.js · lib/main.js
@deepseek-ai 包数 340，其中 dsh-desktop-host 不存在

locateDshExe：只认 deepseek harness.exe + Program Files\DeepSeek Harness
本机实际：D:\DSH NEXT\DSH NEXT.exe
```

**实测比 issue 写得更深一层。** 原报告把问题描述成「硬编码了 `app.asar.unpacked` / `app` / `node_modules` 三个前缀」，听起来像前缀写错、多试几个位置就能撞上。实测是：DSH NEXT 的 asar **没有顶层 `dsh/` 目录**，且 `dsh-desktop-host` 这个包在 340 个 `@deepseek-ai` 包里**根本不存在**。所以这不是「路径不对」，是**这个包在 DSH NEXT 里不存在** —— 拼接再多前缀也拼不出来。

真入口 `app.asar/lib/desktop-cli.js` 一直都在，调用姿势（`--expose-internals <path> --profile … --json headless <task>`）一个字都不用改。

顺带确认了 issue 里那句「设 `DSH_EXE`」为什么是**必要条件**：`locateDshExe` 只认 `deepseek harness.exe`，DSH NEXT 的主程序叫 `DSH NEXT.exe`。CLI 路径修好、exe 仍然定位不到，依然跑不起来。

## 最小修法

**#557（保留期）**

- 给 `dream_runs` 一条真正的删除路径（或一个 `dreamRunsRetentionDays` 键落到它），而不是只有 `input` 裁剪。行本身不增长，`decisions` / `outcome` 迟早也会成为主体。
- 若要保留审计价值：保留「轮次骨架」（id / 时间 / run_type / 计数字段），删掉大 TEXT；这样行数和体积解耦。
- 任何清理都要在文档里说清 `VACUUM` 的事，否则「清了库没小」会被当成没清。

**#578（T1 入口）**

- `locateCliJs` 改候选探测：至少 `lib/desktop-cli.js` 与 `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 两种布局，**在父进程**探测（Electron 的 fs 能看见 asar 内路径，纯 node 子进程不能）。全不命中 `return null`，走 `kind: "environment"` 降级。
- `locateDshExe` 把 exe 名做候选（`DSH NEXT.exe` / `DeepSeek Harness.exe`），失败时**列出试过的位置**。
- 编排层把 `reason` 透传进报告，别让 `stubReportIfMissing()` 盖住真实原因 —— 这是「无输出」的另一半。

## 局限（写在结论前面）

- 两个审计器都是**静态判定 + 现场数字**，不跑真实路径：`#557` 不执行清理、`#578` 不 spawn 宿主。它们回答「缺陷形状在不在」，不回答「跑起来会不会成功」——后者只能在修好之后用真实 T1 跑一次验证。
- `#557` 的页比依赖 `dbstat`。没有该 vtab 时脚本宁可不报百分比，也不拿行数估算一个假数。
- `#578` 的 asar 解析只读**目录索引**，不展开 entry 内容：它证明「路径不存在」，不证明「真入口一定能跑」。
- 两条 issue 的原始版本都比本机旧（`#557` 报在 0.10.1、`#578` 报在 0.11.0）。本机 `0.12.0` 的结论不能反推它们当年的表现，只能说明**同一个形状是否还在**。

## 与「三条纪律」的关系

- **先只读取证**：两个脚本都零依赖只读，跑十次和跑一次结果一样，不改变被测环境。
- **区分环境问题与产品缺陷**：`#578` 是这次的范例 —— 一条路径在「DeepSeek Harness」布局下成立、在「DSH NEXT」布局下不成立。审计器把「源码怎么写」和「本机安装长什么样」分开报，就是为了不把环境差异误判成产品缺陷，也不反过来放过真正的硬编码。
- **给最小修法**：两条都写在报告里，且都不要求重构 —— 一条是加键/加删除路径，一条是候选探测 + 透传原因。
