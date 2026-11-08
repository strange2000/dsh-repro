# mneme 保留期审计器 · `dream_runs`

> [English](README.en.md) · 中文

一条命令回答一个问题：**你这份 mneme 里，`dream_runs` 有没有人负责让它变老、变小？**

对应上游 [slow-stack/mneme#557](https://github.com/slow-stack/mneme/issues/557)：0.10.1 时这张审计表没有保留期键、无界增长，实测占库约 43% 的页，而四个 `*RetentionDays` 全都不覆盖它。

这类缺陷的特点是**永远不会报错**：库只是慢慢变大，直到备份、迁移、快照一起变慢，而那时已经很难查清是哪个表。

```bash
node audit-retention.cjs                        # 自动找 profile 里的 mneme + 默认库 ~/.dsh/memory/memory.db
node audit-retention.cjs --plugin <dir> --db <file>
node audit-retention.cjs --json                 # 机器可读
node audit-retention.cjs --selftest             # 合成源码 + 内存库，先验判定器本身
```

零依赖、只读：源码 `readFileSync`，数据库以 `readOnly` 打开，全程不写一个字节。退出码 `0` = 审计跑完（缺陷有无不影响退出码）、`1` = 自检没通过、`2` = 参数或环境错误。

## 它判什么

| 项 | 判据 | 权重 |
|---|---|---|
| **A** `dream_runs` 本表有 `DELETE` 路径 | `DELETE FROM dream_runs` 或 `deleteOldDreamRuns` / `purgeDreamRuns` 之族 | 结论项 |
| **B** 有保留期键落到 `dream_runs` | `dreamRunsRetentionDays` 之类 | 结论项 |
| **C** 有「只清 `input` 列」的裁剪入口 | `UPDATE dream_runs SET input = NULL` | 结论项（决定 PARTIAL） |
| **D** 实测行数 / 占库页比 / `input` 字节 / 时间跨度 | `dbstat` + `LENGTH(input)` | 现场证据，**不参与结论** |

顺带把「现有保留期键 → 清理函数 → 目标表」三者的对应关系打印出来 —— 这才是回答「为什么四个键都不覆盖它」的地方，而不是靠读 changelog。

结论三档：

- `FIXED` —— 有删除路径且有保留期键（或某个 purge 函数直接指向 `dream_runs`）：表会自己变老。
- `PARTIAL` —— 没有删除路径、没有保留期键，但有 `input` 裁剪：只治了最肥的那一列，行本身永久保留。
- `DEFECT` —— 三者都没有：无界增长，与 #557 描述一致。
- `SUSPECT` —— 有保留期键却找不到删除路径（或相反）：键可能是死的，需要人工确认调用链。

## 本机实测（2026-11-08，mneme `0.12.0`，profile `desktop`）

```
源码侧   A MISS   B MISS   C ok
现有保留期键 4 个：recallRetentionDays / reflectionFailureRetentionDays /
                  llmAudit.retentionDays / distillRecords.retentionDays（均默认 90 天）
清理函数 3 个：purgeRecallRunsOlderThan → recall_runs
              deleteOldLlmAudits     → llm_audit_logs
              deleteOldFailures      → failure_memories
dream_runs 被覆盖：没有任何清理函数指向它

数据侧   库 60.6 MB · page 4096 × 15515 · freelist 0
         dream_runs 92 行 → 21.95 MB → 36.2% 的页
         input 列 12.21 MB（92 行有值，平均 136 KB/行）
         时间跨度 2026-10-14 → 2026-10-18

结论 PARTIAL
```

三件值得注意的事：

1. **行数极少、体积极大。** 92 行占 36.2% 的页，平均一行 136 KB 的 `input`。这类「行数看起来没问题」的表最容易被漏掉 —— 按行数做清理阈值永远触发不了。
2. **四个保留期键确实一个都不管它。** 3 个清理函数分别指向 `recall_runs` / `llm_audit_logs` / `failure_memories`，`distillRecords.retentionDays` 管的是 `distill_records`。这与 #557 的描述逐字对上，只是版本从 0.10.1 走到了 0.12.0。
3. **0.12.0 新增了部分缓解。** `clearDreamRunInputs(before)`（`UPDATE dream_runs SET input = NULL`，`run_type != 'organize'`）挂在维护/回收入口上，配置键是 `distillRecords.retentionDays`。它能把最肥的 `input` 清掉，但**行本身、`decisions`、`outcome` 永久保留** —— 所以本轮结论是 `PARTIAL` 而不是 `FIXED`。

## 两个必须写下来的提醒

- **删行不会自动归还文件页。** SQLite 删掉行后页进 freelist，文件要 `VACUUM` 才会缩。所以「清了但库没变小」是预期现象，不是没清 —— 本机当前 `freelist 0`，说明此刻没有待回收的空页。
- **`dbstat` 不保证可用。** 没有该 vtab 时占库页比显示为空，脚本不会拿行数去估算一个假的百分比。

## 自检

`--selftest` 用**合成源码**（缺陷形 / 部分缓解形 / 修好形三种）喂同一判定函数，再用**内存库**造 3 行已知大小的 `dream_runs` 验数据侧算术。当前 6/6 通过。

这一步不是形式主义：同目录的另外两个审计器（`ofm-0002`、`bili-0003`）和 settings.section 扫描器，**三个脚本的判定器 bug 全是首跑自检抓出来的**，而它们错起来都特别像正确答案。
