## 与 #424 的关系：这是「失败重试」的另一半

<!-- tl;dr-en -->
> **English TL;DR**
> - This is a follow-up comment on #424, not a duplicate: #424 covers *transient* failures (429 / 5xx / timeout) where a retry usually succeeds.
> - This report covers the opposite case: a **deterministic** failure where every retry reproduces the same result — `finish_reason` is `stop`, i.e. the model answered normally and the parse rejected the answer.
> - Retry yield is exactly 0 (20 failures out of 20 on the same window) while retry cost grows: input went 8194 → 11118 tokens, monotonically.
> - So once #424 lands, the window stuck at `last_seq=2229` will still be retried forever — in the current design "failed" only ever means "not finished yet".
> - Suggested guardrail below: an attempt cap plus an explicit give-up state, without changing normal semantics.

#424 第 4 项提的是**失败短重试**（近 7 天 102 轮里 12 轮失败，11.8%，改成一天一次后「一次失败 = 浪费一整天」）。本文描述的是它的反面情形，两者互补而非重复：

| | #424 第 4 项覆盖的失败 | 本文描述的失败 |
|---|---|---|
| 性质 | 偶发、可自愈（429/5xx/超时） | **确定性**、重试必然同结果 |
| `finish_reason` | `error` / 空 | **`stop`**（正常返回，非截断/超时/429） |
| 重试收益 | 大概率第二次成功 | **0**：同一窗口 20/20 全失败 |
| 重试代价 | 多花一次 token | 输入从 8194 → 11118 tokens **单调递增**，越重试越贵 |

也就是说：#424 落地后只会让「偶发失败」重试得更聪明，而本 issue 里那个游标卡在 `last_seq=2229` 的窗口仍会一直被重试 —— 因为按现在的逻辑，失败在语义上就等于「还没提炼完，下次接着来」，没有任何路径会承认「这段内容该被放弃」。

## 建议的最小护栏（不改变正常语义）

1. **连续 N 次同类解析失败 → 强制跳过该窗口**：把这一段标记为 skipped 并推进游标（或对半切后各试一次），保证「重试」有上界。核心是让 `:869-877` 那条 `return` 不再等价于「永远重来」。
2. **把原始输出留在 audit 里**：现在 `llm_audit_logs.metadata` 恒为 `null`、`distillRecognitionRecords` 默认关，所以我只能靠外部复现来证明「模型输出里连 `[` 都没有」。留 1–2KB 的原始响应（或首尾各 512 字符）就能让人一眼看出是「模型没照格式」还是「格式变了解析器没跟上」。
3. 若 #424 第 5 项（手动触发入口）先落地，至少能给用户一个**人工解卡**的口子；但确定性失败仍需自动跳过 —— 手动入口只是止血，不是修复。

## 补充：复现方法（无需改代码）

把 `lib/summarize.js` 里 `buildTranscript` 的产物直接 POST 到任意 OpenAI 兼容端点（system 用 `STR.prompts.summary`，user 用转录原文），即可稳定复现：

- 极简服从性（system 只说"输出 JSON"）→ 正常返回 JSON，说明 relay 未篡改 system；
- 现行构造（转录裸放 user）→ 0–2 次成功，模型接着对话往下写中文；
- 给转录加显式分隔符 + 在 user 里重申「你是第三方提炼员，不是对话参与者」→ 稳定返回 JSON。

复现脚本与原始审计数据（20 条 `invalid summary JSON` 的完整字段、`distill_cursors` 快照）我可以直接贴上来，需要的话说一声。
